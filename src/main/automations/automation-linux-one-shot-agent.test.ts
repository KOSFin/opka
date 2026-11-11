import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  AutomationCommandClaimV1,
  AutomationCommandDefinitionV1
} from '../../shared/automation-command-domain'

const spy = vi.hoisted(() => ({
  fingerprintChanged: false,
  execute: vi.fn(),
  version: vi.fn(async () => ({ status: 'ready' as const }))
}))
vi.mock('../ipc/command-path-resolver', () => ({
  resolveCommandOnLocalPath: vi.fn(async () => '/synthetic/codex')
}))
vi.mock('../preflight/codex-cli-installation', () => ({
  readCodexCliInstallation: spy.version
}))
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(async () => ({
    dev: 1,
    ino: spy.fingerprintChanged ? 2 : 1,
    size: 20,
    mtimeMs: 30,
    ctimeMs: 40,
    mode: 0o755,
    isFile: () => true
  }))
}))
vi.mock('./automation-linux-cgroup-command', () => ({
  executeLinuxCgroupAutomationAgent: spy.execute
}))

import { createLinuxOneShotAutomationAgent } from './automation-linux-one-shot-agent'

function fixture() {
  const now = Date.now()
  const definition = AutomationCommandDefinitionV1.parse({
    id: 'automation-1',
    name: 'Check',
    revision: 1,
    runContext: {
      kind: 'workspace-run',
      projectId: 'project-1',
      hostId: 'local',
      projectHostSetupId: 'setup-1',
      repoId: 'repo-1',
      path: '/synthetic/workspace'
    },
    sourceContext: null,
    projectId: 'project-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: 'workspace-1',
    baseBranch: null,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0',
    dtstart: now,
    enabled: true,
    nextRunAt: now,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 60,
    createdAt: now,
    updatedAt: now,
    execution: {
      version: 1,
      command: { kind: 'program', executable: 'true', argv: [] },
      condition: 'exit_zero',
      agent: { agentId: 'codex', prompt: 'Review', sessionPolicy: 'ephemeral' },
      policy: { timeoutSeconds: 900, commandTimeoutSeconds: 60, idempotent: false, maxAttempts: 1 },
      reportTarget: null
    }
  })
  const claim = AutomationCommandClaimV1.parse({
    automationId: definition.id,
    runId: 'run-1',
    definitionRevision: 1,
    hostId: 'local',
    hostGeneration: 7,
    acquisitionId: '11111111-1111-4111-8111-111111111111',
    attempt: 1,
    phase: 'agent',
    createdAt: now,
    agentIntent: {
      backend: 'linux_cgroup_v1',
      unitName: 'orca-automation-22222222-2222-4222-8222-222222222222.scope',
      childName: 'agent',
      receiptDirectory: '/synthetic/receipt',
      execMayHappen: true,
      binaryPath: '/synthetic/codex',
      binaryFingerprint: '1:1:20:30:40:493'
    }
  })
  let current = claim
  const store = { getCommandAutomationClaim: () => current }
  const runs = {
    bindAgentProcessIntent: vi.fn(async () => current),
    recordAgentExitProof: vi.fn(async () => current)
  }
  const adapter = createLinuxOneShotAutomationAgent({
    store,
    runs,
    hostGeneration: 7,
    isCurrentOwner: () => true,
    resolveExistingWorkspaceCwd: async () => '/synthetic/workspace'
  })
  return {
    definition,
    claim,
    adapter,
    setCurrent: (value: typeof claim) => {
      current = value
    }
  }
}

describe('model-free one-shot gate', () => {
  beforeEach(() => {
    spy.fingerprintChanged = false
    spy.execute.mockReset()
    spy.version.mockResolvedValue({ status: 'ready' })
    spy.execute.mockImplementation(async (input) =>
      (await input.mayReleaseGate())
        ? {
            verdict: 'exited',
            observation: {
              exitCode: 0,
              timedOut: false,
              error: null,
              stdout: '',
              stdoutTruncated: false
            }
          }
        : { verdict: 'unverifiable' }
    )
  })

  it('passes only an ephemeral Codex argv and prompt on stdin after a current gate', async () => {
    const { definition, claim, adapter } = fixture()
    const agent = definition.execution.agent
    if (!agent) {
      throw new Error('Fixture agent missing')
    }
    expect(await adapter.supportsDefinition(definition)).toBe(true)
    expect(await adapter.run(agent, definition, claim)).toEqual({
      verdict: 'exited',
      success: true
    })
    expect(spy.execute).toHaveBeenCalledOnce()
    expect(spy.execute.mock.calls[0][0]).toMatchObject({
      executable: '/synthetic/codex',
      args: ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only'],
      prompt: 'Review'
    })
  })

  it('refuses changed binary or cancellation before opening the gate', async () => {
    const { definition, claim, adapter, setCurrent } = fixture()
    const agent = definition.execution.agent
    if (!agent) {
      throw new Error('Fixture agent missing')
    }
    spy.execute.mockImplementationOnce(async (input) => {
      spy.fingerprintChanged = true
      return (await input.mayReleaseGate())
        ? { verdict: 'exited', observation: { exitCode: 0 } }
        : { verdict: 'unverifiable' }
    })
    expect(await adapter.run(agent, definition, claim)).toEqual({
      verdict: 'unverifiable'
    })
    spy.fingerprintChanged = false
    setCurrent({ ...claim, cancelRequestedAt: Date.now() })
    expect(await adapter.run(agent, definition, claim)).toEqual({
      verdict: 'unverifiable'
    })
    expect(spy.execute).toHaveBeenCalledOnce()
  })
})
