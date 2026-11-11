import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import {
  AutomationCommandDefinitionV1,
  readAutomationCommandsV1Domain
} from '../../../shared/automation-command-domain'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  claimAutomationCommandRun,
  type CommandRunClaimOperations,
  type CommandRunClaimRequest
} from './automation-command-claim-operations'

const NOW = Date.UTC(2026, 10, 9, 12)

function definition(path = '/synthetic/folder') {
  return AutomationCommandDefinitionV1.parse({
    id: 'command-1',
    name: 'Synthetic command',
    revision: 2,
    runContext: {
      kind: 'workspace-run',
      projectId: 'folder-1',
      hostId: LOCAL_EXECUTION_HOST_ID,
      projectHostSetupId: 'setup-1',
      repoId: 'folder-1',
      path
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
      command: { kind: 'program', executable: 'synthetic-command', argv: [] },
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
}

function fixture(path?: string) {
  const state: PersistedState = getDefaultPersistedState('/synthetic-profile')
  state.automationRuns = []
  state.automationCommandsV1 = {
    version: 1,
    definitions: [definition(path)],
    activeClaims: [],
    manualReceipts: []
  }
  const flush = vi.fn(() => {
    expect(state.automationRuns).toHaveLength(1)
    expect(state.automationCommandsV1).toMatchObject({ activeClaims: [{ phase: 'acquiring' }] })
  })
  const markDomainsDirty = vi.fn()
  const recordAutomationRunsMutation = vi.fn()
  const operations: CommandRunClaimOperations = {
    state,
    flush,
    markDomainsDirty,
    recordAutomationRunsMutation
  }
  const request: CommandRunClaimRequest = {
    automationId: 'command-1',
    definitionRevision: 2,
    ownerHostId: LOCAL_EXECUTION_HOST_ID,
    ownerHostGeneration: 4,
    scheduledFor: NOW,
    trigger: 'manual',
    manualRequest: { key: 'key-1', createdAt: NOW, payloadHash: 'a'.repeat(64) },
    now: NOW
  }
  return { state, operations, request, flush, markDomainsDirty, recordAutomationRunsMutation }
}

describe('command run admission', () => {
  it('writes one active claim, receipt and run row before one flush; replays the same key', () => {
    const { state, operations, request, flush, markDomainsDirty, recordAutomationRunsMutation } =
      fixture()
    const first = claimAutomationCommandRun(operations, request)
    expect(first.kind).toBe('claimed')
    expect(state.automationRuns[0]).toMatchObject({
      automationId: 'command-1',
      sessionKind: 'command',
      status: 'dispatching',
      commandExecution: { phase: 'acquiring', observation: 'unverifiable' }
    })
    expect(markDomainsDirty).toHaveBeenCalledOnce()
    expect(recordAutomationRunsMutation).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledOnce()
    const replay = claimAutomationCommandRun(operations, request)
    expect(replay).toMatchObject({ kind: 'replayed', run: state.automationRuns[0] })
    expect(flush).toHaveBeenCalledOnce()
    expect(() =>
      claimAutomationCommandRun(operations, {
        ...request,
        manualRequest: { key: 'key-1', createdAt: NOW, payloadHash: 'b'.repeat(64) }
      })
    ).toThrow('different content')
    const overlappingRequest = {
      ...request,
      manualRequest: { key: 'key-2', createdAt: NOW, payloadHash: 'b'.repeat(64) }
    }
    expect(
      claimAutomationCommandRun(operations, {
        ...request,
        manualRequest: overlappingRequest.manualRequest
      })
    ).toMatchObject({ kind: 'overlap' })
    expect(state.automationCommandsV1).toMatchObject({
      activeClaims: [{ overlapCount: 1 }],
      manualReceipts: [{}, { requestKey: 'key-2', outcome: 'overlap' }]
    })
    expect(state.automationRuns[0]?.commandExecution?.overlapCount).toBe(1)
    state.automationCommandsV1 = {
      ...readAutomationCommandsV1Domain(state.automationCommandsV1),
      activeClaims: []
    }
    expect(claimAutomationCommandRun(operations, overlappingRequest)).toMatchObject({
      kind: 'overlap',
      activeRunId: state.automationRuns[0]?.id
    })
    expect(state.automationRuns).toHaveLength(1)
  })

  it('rejects stale owner, definition, request window, SSH and WSL before any row', () => {
    const { state, operations, request, flush } = fixture()
    expect(() =>
      claimAutomationCommandRun(operations, { ...request, definitionRevision: 1 })
    ).toThrow('changed')
    expect(() =>
      claimAutomationCommandRun(operations, { ...request, ownerHostId: 'ssh:foreign' })
    ).toThrow('execution host')
    expect(() =>
      claimAutomationCommandRun(operations, {
        ...request,
        manualRequest: {
          key: 'old',
          createdAt: NOW - 24 * 60 * 60 * 1000 - 1,
          payloadHash: 'a'.repeat(64)
        }
      })
    ).toThrow('replay window')
    expect(flush).not.toHaveBeenCalled()
    expect(state.automationRuns).toHaveLength(0)

    const wsl = fixture('\\\\wsl.localhost\\Ubuntu\\home\\dev\\app')
    expect(() => claimAutomationCommandRun(wsl.operations, wsl.request)).toThrow('WSL workspace')
    const ssh = fixture()
    ssh.state.automationCommandsV1 = {
      version: 1,
      definitions: [{ ...definition(), executionTargetType: 'ssh', executionTargetId: 'ssh-1' }],
      activeClaims: [],
      manualReceipts: []
    }
    expect(() => claimAutomationCommandRun(ssh.operations, ssh.request)).toThrow('execution host')
  })

  it('keeps scheduled occurrence high-water and holds overlap until the claim settles', () => {
    const { state, operations, request } = fixture()
    const scheduled: CommandRunClaimRequest = {
      ...request,
      trigger: 'scheduled',
      manualRequest: undefined
    }
    expect(claimAutomationCommandRun(operations, scheduled).kind).toBe('claimed')
    expect(state.automationCommandsV1).toMatchObject({
      definitions: [{ lastAdmittedOccurrenceAt: NOW }]
    })
    expect(
      claimAutomationCommandRun(operations, { ...scheduled, scheduledFor: NOW - 60_000 })
    ).toMatchObject({ kind: 'overlap' })
    expect(state.automationRuns).toHaveLength(1)
  })
})
