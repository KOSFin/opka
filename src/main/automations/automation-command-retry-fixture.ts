import { vi } from 'vitest'
import {
  AutomationCommandDefinitionV1,
  readAutomationCommandsV1Domain
} from '../../shared/automation-command-domain'
import type { AutomationCommandObservation } from '../../shared/automation-command-execution'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import {
  advanceAutomationCommandRun,
  settleAutomationCommandRun
} from '../persistence/scheduling-automations/automation-command-progress-operations'
import {
  bindAutomationCommandProcessIntent,
  recordAutomationCommandExitProof
} from '../persistence/scheduling-automations/automation-command-process-operations'
import { retryAutomationCommandRun } from '../persistence/scheduling-automations/automation-command-retry-operations'
import type { AutomationRunWriter } from './automation-run-writer'

export const RETRY_NOW = 1_000_000
export const failedCommand: AutomationCommandObservation = {
  exitCode: 7,
  timedOut: false,
  error: null,
  stdout: '',
  stdoutTruncated: false
}

export function commandRetryFixture() {
  const definition = AutomationCommandDefinitionV1.parse({
    id: 'command-1',
    name: 'Retry folder',
    revision: 1,
    runContext: {
      kind: 'workspace-run',
      projectId: 'folder-1',
      hostId: 'local',
      projectHostSetupId: 'setup-1',
      repoId: 'folder-1',
      path: '/synthetic/folder'
    },
    sourceContext: null,
    projectId: 'folder-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: null,
    baseBranch: null,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=12;BYMINUTE=0',
    dtstart: RETRY_NOW,
    enabled: true,
    nextRunAt: RETRY_NOW,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 60,
    createdAt: RETRY_NOW,
    updatedAt: RETRY_NOW,
    execution: {
      version: 1,
      command: { kind: 'program', executable: 'check', argv: [] },
      condition: 'exit_zero_and_changed',
      agent: null,
      reportTarget: {
        runtimeId: 'runtime-1',
        hostId: 'local',
        workspaceId: 'folder-1',
        chatSessionId: 'chat-1',
        registrationGeneration: 1
      },
      policy: { timeoutSeconds: 90, commandTimeoutSeconds: 60, idempotent: true, maxAttempts: 2 }
    }
  })
  const state = buildProfileStateCutoverFixture('/fixture')
  state.automationRuns = [
    {
      ...state.automationRuns[0],
      id: 'run-1',
      automationId: definition.id,
      sessionKind: 'command',
      status: 'dispatching',
      createdAt: RETRY_NOW,
      commandExecution: {
        version: 1,
        phase: 'command',
        attempt: 1,
        observation: 'unverifiable',
        finalReason: null
      }
    }
  ]
  state.automationCommandsV1 = {
    version: 1,
    hostEpoch: 3,
    definitions: [definition],
    activeClaims: [
      {
        automationId: definition.id,
        runId: 'run-1',
        definitionRevision: 1,
        hostId: 'local',
        hostGeneration: 3,
        acquisitionId: '11111111-1111-4111-8111-111111111111',
        attempt: 1,
        phase: 'command',
        createdAt: RETRY_NOW,
        overlapCount: 2,
        processIntent: {
          backend: 'linux_cgroup_v1',
          childName: 'command',
          unitName: 'orca-automation-11111111-1111-4111-8111-111111111111.scope',
          receiptDirectory: '/tmp/retry-first'
        },
        runSnapshot: {
          title: 'Retry folder run 1',
          scheduledFor: RETRY_NOW,
          trigger: 'manual',
          workspaceId: null,
          createdAt: RETRY_NOW,
          runNumber: 1
        }
      }
    ],
    manualReceipts: [
      {
        automationId: definition.id,
        runId: 'run-1',
        requestKey: 'manual-1',
        createdAt: RETRY_NOW,
        payloadHash: 'a'.repeat(64)
      }
    ]
  }
  const operations = { state, flush: vi.fn(), markDomainsDirty: vi.fn() }
  const readClaim = () => readAutomationCommandsV1Domain(state.automationCommandsV1).activeClaims[0]
  const claim = readClaim()
  const fence = {
    automationId: claim.automationId,
    runId: claim.runId,
    acquisitionId: claim.acquisitionId,
    hostGeneration: 3,
    expectedPhase: 'command' as const
  }
  const persistExit = (observation: AutomationCommandObservation) => {
    const current = readClaim()
    const currentFence = { ...fence, acquisitionId: current.acquisitionId }
    bindAutomationCommandProcessIntent(operations, currentFence, {
      childCgroupPath: `/sys/fs/cgroup/${current.processIntent?.unitName}/command`,
      blockedChildPid: 42,
      blockedChildStartTime: '500'
    })
    recordAutomationCommandExitProof(operations, currentFence, observation, RETRY_NOW + 1)
  }
  const runs = {
    advanceCommandRun: vi.fn<AutomationRunWriter['advanceCommandRun']>(async (f, update) =>
      advanceAutomationCommandRun(operations, f, update)
    ),
    retryCommandRun: vi.fn<AutomationRunWriter['retryCommandRun']>(async (f, now) =>
      retryAutomationCommandRun(operations, f, now)
    ),
    settleCommandRun: vi.fn<AutomationRunWriter['settleCommandRun']>(async (f, result) =>
      settleAutomationCommandRun(operations, f, result)
    )
  }
  return { definition, claim, fence, state, operations, readClaim, persistExit, runs }
}
