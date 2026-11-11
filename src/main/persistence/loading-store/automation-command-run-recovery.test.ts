import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import {
  AutomationCommandDefinitionV1,
  readAutomationCommandsV1Domain
} from '../../../shared/automation-command-domain'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { recoverActiveAutomationCommandRuns } from './automation-command-run-recovery'

const NOW = Date.UTC(2026, 10, 9, 12)

function fixture() {
  const state = getDefaultPersistedState('/synthetic-profile')
  const definition = AutomationCommandDefinitionV1.parse({
    id: 'command-1',
    name: 'Check folder',
    revision: 2,
    runContext: {
      kind: 'workspace-run',
      projectId: 'folder-1',
      hostId: LOCAL_EXECUTION_HOST_ID,
      projectHostSetupId: 'setup-1',
      repoId: 'folder-1',
      path: '/synthetic/folder'
    },
    sourceContext: null,
    projectId: 'folder-1',
    executionTargetType: 'local',
    executionTargetId: LOCAL_EXECUTION_HOST_ID,
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: null,
    baseBranch: null,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=12;BYMINUTE=0',
    dtstart: NOW,
    enabled: true,
    nextRunAt: NOW,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: NOW,
    updatedAt: NOW,
    execution: {
      version: 1,
      command: { kind: 'program', executable: 'check', argv: [] },
      condition: 'never_agent',
      agent: null,
      policy: {
        timeoutSeconds: 900,
        commandTimeoutSeconds: 60,
        idempotent: false,
        maxAttempts: 1
      },
      reportTarget: null
    }
  })
  state.automationCommandsV1 = {
    version: 1,
    definitions: [definition],
    activeClaims: [
      {
        automationId: definition.id,
        runId: 'run-1',
        definitionRevision: 2,
        hostId: LOCAL_EXECUTION_HOST_ID,
        hostGeneration: 4,
        acquisitionId: 'acquisition-1',
        attempt: 1,
        phase: 'command',
        createdAt: NOW,
        runSnapshot: {
          title: 'Check folder run 1',
          scheduledFor: NOW,
          trigger: 'manual',
          workspaceId: null,
          createdAt: NOW,
          runNumber: 1
        }
      }
    ],
    manualReceipts: []
  }
  return state
}

describe('active command run recovery', () => {
  it('restores the same run ID as unverifiable after an older host prunes its row', () => {
    const state = fixture()
    const markNeedsSave = vi.fn()
    const runs = recoverActiveAutomationCommandRuns(state, [], markNeedsSave)
    expect(runs).toMatchObject([
      {
        id: 'run-1',
        sessionKind: 'command',
        status: 'dispatching',
        commandExecution: { phase: 'unverifiable', observation: 'unverifiable' }
      }
    ])
    expect(markNeedsSave).toHaveBeenCalledOnce()
  })

  it('does not trust an older final status while the opaque claim is active', () => {
    const state = fixture()
    const original = recoverActiveAutomationCommandRuns(state, [], vi.fn())[0]
    const markNeedsSave = vi.fn()
    const runs = recoverActiveAutomationCommandRuns(
      state,
      [{ ...original, status: 'dispatch_failed', error: 'Old watcher lost terminal' }],
      markNeedsSave
    )
    expect(runs[0]).toMatchObject({
      id: 'run-1',
      status: 'dispatching',
      commandExecution: { phase: 'unverifiable' }
    })
    expect(markNeedsSave).toHaveBeenCalledOnce()
  })

  it('keeps a durable final report and clears its proven claim after restart', () => {
    const state = fixture()
    const original = recoverActiveAutomationCommandRuns(state, [], vi.fn())[0]
    const domain = readAutomationCommandsV1Domain(state.automationCommandsV1)
    state.automationCommandsV1 = {
      ...domain,
      activeClaims: domain.activeClaims.map((claim) => ({
        ...claim,
        phase: 'report' as const,
        observation: 'exited' as const
      }))
    }
    const final = {
      ...original,
      status: 'completed' as const,
      commandExecution: {
        version: 1 as const,
        phase: 'settled' as const,
        attempt: 1,
        observation: 'exited' as const,
        finalReason: 'never_agent',
        deliveryStatus: 'history_only' as const
      }
    }
    const markNeedsSave = vi.fn()
    expect(recoverActiveAutomationCommandRuns(state, [final], markNeedsSave)).toEqual([final])
    expect(readAutomationCommandsV1Domain(state.automationCommandsV1).activeClaims).toEqual([])
    expect(markNeedsSave).toHaveBeenCalledOnce()
  })
})
