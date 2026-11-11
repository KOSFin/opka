import { describe, expect, it, vi } from 'vitest'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import {
  AutomationCommandDefinitionV1,
  readAutomationCommandsV1Domain
} from '../../../shared/automation-command-domain'
import {
  adoptProvenAutomationCommandCondition,
  advanceAutomationCommandRun,
  releaseAutomationCommandClaim,
  requestAutomationCommandCancel,
  settleAutomationCommandRun
} from './automation-command-progress-operations'

function fixture() {
  const state = buildProfileStateCutoverFixture('/fixture')
  state.automationRuns = [
    {
      ...state.automationRuns[0],
      id: 'run-1',
      automationId: 'command-1',
      sessionKind: 'command',
      status: 'dispatching',
      commandExecution: {
        version: 1,
        phase: 'acquiring',
        attempt: 1,
        observation: 'unverifiable',
        finalReason: null
      }
    }
  ]
  state.automationCommandsV1 = {
    version: 1,
    definitions: [],
    activeClaims: [
      {
        automationId: 'command-1',
        runId: 'run-1',
        definitionRevision: 1,
        hostId: 'local',
        hostGeneration: 3,
        acquisitionId: 'acquisition-1',
        attempt: 1,
        phase: 'acquiring',
        createdAt: 1,
        observation: 'unverifiable'
      }
    ],
    manualReceipts: []
  }
  const flush = vi.fn()
  const markDomainsDirty = vi.fn()
  const recordAutomationRunsMutation = vi.fn()
  const operations = { state, flush, markDomainsDirty, recordAutomationRunsMutation }
  const fence = {
    automationId: 'command-1',
    runId: 'run-1',
    acquisitionId: 'acquisition-1',
    hostGeneration: 3,
    expectedPhase: 'acquiring' as const
  }
  return { state, operations, fence, flush }
}

describe('command run progress', () => {
  it('keeps an active claim through report, then settles with the same run ID', () => {
    const { state, operations, fence, flush } = fixture()
    const report = advanceAutomationCommandRun(operations, fence, {
      phase: 'report',
      observation: 'exited',
      finalReason: 'never_agent',
      outputSnapshot: {
        format: 'plain_text',
        content: 'No change',
        capturedAt: 2,
        truncated: false
      }
    })
    expect(report).toMatchObject({ id: 'run-1', commandExecution: { phase: 'report' } })
    expect(state.automationCommandsV1).toMatchObject({ activeClaims: [{ runId: 'run-1' }] })
    const settled = settleAutomationCommandRun(
      operations,
      { ...fence, expectedPhase: 'report' },
      { status: 'completed', finalReason: 'never_agent', deliveryStatus: 'history_only' }
    )
    expect(settled).toMatchObject({ id: 'run-1', status: 'completed' })
    expect(state.automationCommandsV1).toMatchObject({ activeClaims: [{ runId: 'run-1' }] })
    releaseAutomationCommandClaim(operations, { ...fence, expectedPhase: 'report' })
    expect(state.automationCommandsV1).toMatchObject({ activeClaims: [] })
    expect(flush).toHaveBeenCalledTimes(3)
  })

  it('refuses an unproven continuation and a stale acquisition', () => {
    const { operations, fence, flush } = fixture()
    expect(() =>
      advanceAutomationCommandRun(operations, fence, {
        phase: 'report',
        observation: 'unverifiable'
      })
    ).toThrow('proven preceding exit')
    expect(() =>
      advanceAutomationCommandRun(
        operations,
        { ...fence, acquisitionId: 'stale' },
        { phase: 'command', observation: 'live' }
      )
    ).toThrow('acquisition changed')
    expect(flush).not.toHaveBeenCalled()
  })

  it('persists one idempotent cancel intent without settling the claim', () => {
    const { state, operations, fence, flush } = fixture()
    requestAutomationCommandCancel(operations, fence, 'cancel-1', 2)
    requestAutomationCommandCancel(operations, fence, 'cancel-1', 3)
    expect(state.automationCommandsV1).toMatchObject({
      activeClaims: [{ cancelRequestKey: 'cancel-1', cancelRequestedAt: 2 }]
    })
    expect(flush).toHaveBeenCalledOnce()
  })

  it('CAS adopts only a proven pre-agent condition into the persisted newer epoch', () => {
    const { state, operations, fence, flush } = fixture()
    const definition = AutomationCommandDefinitionV1.parse({
      id: 'command-1',
      name: 'Check',
      revision: 1,
      runContext: {
        kind: 'workspace-run',
        projectId: 'folder-1',
        hostId: 'local',
        projectHostSetupId: 'setup-1',
        repoId: 'folder-1',
        path: '/fixture'
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
      dtstart: 1,
      enabled: true,
      nextRunAt: 2,
      missedRunPolicy: 'run_once_within_grace',
      missedRunGraceMinutes: 60,
      createdAt: 1,
      updatedAt: 1,
      execution: {
        version: 1,
        command: { kind: 'program', executable: 'true', argv: [] },
        condition: 'exit_zero',
        agent: null,
        reportTarget: null,
        policy: {
          timeoutSeconds: 900,
          commandTimeoutSeconds: 60,
          idempotent: false,
          maxAttempts: 1
        }
      }
    })
    state.automationCommandsV1 = {
      version: 1,
      hostEpoch: 4,
      definitions: [definition],
      manualReceipts: [],
      activeClaims: [
        {
          automationId: 'command-1',
          runId: 'run-1',
          definitionRevision: 1,
          hostId: 'local',
          hostGeneration: 3,
          acquisitionId: 'acquisition-1',
          attempt: 1,
          phase: 'condition',
          createdAt: 1,
          observation: 'exited',
          processIntent: {
            backend: 'linux_cgroup_v1',
            unitName: 'orca-automation-11111111-1111-4111-8111-111111111111.scope',
            childName: 'command',
            receiptDirectory: '/tmp/receipt',
            childCgroupPath:
              '/sys/fs/cgroup/orca-automation-11111111-1111-4111-8111-111111111111.scope/command',
            blockedChildPid: 123,
            blockedChildStartTime: '456',
            execMayHappen: true,
            exitProof: {
              verifiedAt: 2,
              exitCode: 0,
              timedOut: false,
              error: null,
              stdout: '',
              stdoutTruncated: false,
              stderr: '',
              stderrTruncated: false
            }
          }
        }
      ]
    }
    const conditionFence = { ...fence, expectedPhase: 'condition' as const }
    expect(() => adoptProvenAutomationCommandCondition(operations, conditionFence, 5)).toThrow(
      'cannot be adopted'
    )
    const domain = readAutomationCommandsV1Domain(state.automationCommandsV1)
    state.automationCommandsV1 = {
      ...domain,
      activeClaims: domain.activeClaims.map((claim) => ({ ...claim, cancelRequestedAt: 2 }))
    }
    expect(() => adoptProvenAutomationCommandCondition(operations, conditionFence, 4)).toThrow(
      'cannot be adopted'
    )
    state.automationCommandsV1 = domain
    expect(adoptProvenAutomationCommandCondition(operations, conditionFence, 4)).toMatchObject({
      hostGeneration: 4
    })
    expect(flush).toHaveBeenCalledOnce()
    expect(state.automationRuns[0].commandExecution).toMatchObject({ phase: 'condition' })
    expect(() => adoptProvenAutomationCommandCondition(operations, conditionFence, 4)).toThrow(
      'acquisition changed'
    )
  })
})
