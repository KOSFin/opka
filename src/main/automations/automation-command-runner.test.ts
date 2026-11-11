import { describe, expect, it, vi } from 'vitest'
import { AutomationCommandDefinitionV1 } from '../../shared/automation-command-domain'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import { runClaimedAutomationCommand } from './automation-command-runner'
import type { AutomationRunWriter } from './automation-run-writer'

const NOW = Date.UTC(2026, 10, 9, 12)

function fixture() {
  const definition = AutomationCommandDefinitionV1.parse({
    id: 'command-1',
    name: 'Synthetic command',
    revision: 1,
    runContext: {
      kind: 'workspace-run',
      projectId: 'project-fixture',
      hostId: 'local',
      projectHostSetupId: 'setup-local',
      repoId: 'repo-local',
      path: '/fixture/local'
    },
    sourceContext: null,
    projectId: 'repo-local',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: 'repo-local::/fixture/local',
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
      command: { kind: 'program', executable: 'synthetic', argv: [] },
      condition: 'exit_zero_and_changed',
      agent: { agentId: 'codex', prompt: 'Review', sessionPolicy: 'ephemeral' },
      policy: {
        timeoutSeconds: 900,
        commandTimeoutSeconds: 60,
        idempotent: false,
        maxAttempts: 1
      },
      reportTarget: null
    }
  })
  const claim = {
    automationId: definition.id,
    runId: 'run-1',
    definitionRevision: 1,
    hostId: 'local',
    hostGeneration: 1,
    acquisitionId: 'acquisition-1',
    attempt: 1,
    phase: 'acquiring' as const,
    createdAt: NOW
  }
  const original = buildProfileStateCutoverFixture('/fixture').automationRuns[0]
  const run = {
    ...original,
    id: claim.runId,
    automationId: claim.automationId,
    sessionKind: 'command' as const,
    status: 'dispatching' as const
  }
  const runs = {
    advanceCommandRun: vi.fn<AutomationRunWriter['advanceCommandRun']>(async () => run),
    settleCommandRun: vi.fn<AutomationRunWriter['settleCommandRun']>(async () => ({
      ...run,
      status: 'completed' as const
    }))
  }
  const adapter = {
    executeCommand: vi.fn(async () => ({
      verdict: 'exited' as const,
      observation: {
        exitCode: 0,
        timedOut: false,
        error: null,
        stdout: '{"version":1,"changed":false}',
        stdoutTruncated: false
      }
    })),
    runOneShotAgent: vi.fn(async () => ({ verdict: 'exited' as const, success: true })),
    deliverReport: vi.fn(async () => true),
    now: () => NOW
  }
  return { definition, claim, runs, adapter }
}

describe('claimed command pipeline', () => {
  it('records a false condition without acquiring an agent', async () => {
    const input = fixture()
    await runClaimedAutomationCommand(input)
    expect(input.adapter.runOneShotAgent).not.toHaveBeenCalled()
    expect(input.runs.settleCommandRun).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPhase: 'report' }),
      expect.objectContaining({ status: 'skipped_precheck', finalReason: 'condition_false' })
    )
  })

  it('acquires an agent only after a true condition and a durable stage write', async () => {
    const input = fixture()
    input.adapter.executeCommand.mockResolvedValue({
      verdict: 'exited',
      observation: {
        exitCode: 0,
        timedOut: false,
        error: null,
        stdout: '{"version":1,"changed":true}',
        stdoutTruncated: false
      }
    })
    await runClaimedAutomationCommand(input)
    expect(input.adapter.runOneShotAgent).toHaveBeenCalledOnce()
    expect(input.runs.advanceCommandRun.mock.calls.map((call) => call[1].phase)).toEqual([
      'command',
      'condition',
      'agent',
      'report'
    ])
  })

  it('keeps an unverifiable command nonfinal and blocks report delivery', async () => {
    const input = fixture()
    input.adapter.executeCommand.mockRejectedValue(new Error('transport lost'))
    const result = await runClaimedAutomationCommand(input)
    expect(result.kind).toBe('unverifiable')
    expect(input.runs.settleCommandRun).not.toHaveBeenCalled()
    expect(input.adapter.runOneShotAgent).not.toHaveBeenCalled()
    expect(input.adapter.deliverReport).not.toHaveBeenCalled()
  })

  it('resumes a command-only condition from the durable exit proof without another command', async () => {
    const input = fixture()
    const definition = {
      ...input.definition,
      execution: { ...input.definition.execution, agent: null, reportTarget: null }
    }
    const claim = {
      ...input.claim,
      phase: 'condition' as const,
      processIntent: {
        backend: 'linux_cgroup_v1' as const,
        unitName: 'orca-automation-11111111-1111-4111-8111-111111111111.scope',
        childName: 'command' as const,
        receiptDirectory: '/tmp/claim',
        exitProof: {
          verifiedAt: NOW,
          exitCode: 0,
          timedOut: false,
          error: null,
          stdout: '{"version":1,"changed":false}',
          stdoutTruncated: false,
          stderr: '',
          stderrTruncated: false
        }
      }
    }
    await runClaimedAutomationCommand({
      definition,
      claim,
      runs: input.runs,
      adapter: input.adapter
    })
    expect(input.adapter.executeCommand).not.toHaveBeenCalled()
    expect(input.adapter.runOneShotAgent).not.toHaveBeenCalled()
    expect(input.runs.advanceCommandRun.mock.calls.map((call) => call[1].phase)).toEqual(['report'])
    expect(input.runs.settleCommandRun).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPhase: 'report' }),
      expect.objectContaining({ status: 'skipped_precheck' })
    )
  })

  it('refuses replay of an agent stage even when the command exit was proven', async () => {
    const input = fixture()
    const claim = {
      ...input.claim,
      phase: 'agent' as const
    }
    await expect(runClaimedAutomationCommand({ ...input, claim })).rejects.toThrow(
      'later effect stage'
    )
    expect(input.adapter.executeCommand).not.toHaveBeenCalled()
  })
})
