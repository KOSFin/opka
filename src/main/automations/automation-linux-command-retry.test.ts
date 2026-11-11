import { describe, expect, it, vi } from 'vitest'
import { commandRetryFixture } from './automation-command-retry-fixture'
import { createLinuxCommandAutomationAdapter } from './automation-linux-command-adapter'
import { executeLinuxCgroupAutomationCommand } from './automation-linux-cgroup-command'
import { provePriorCommandChildExited } from './automation-linux-cgroup-lifecycle'
import { readAutomationCommandsV1Domain } from '../../shared/automation-command-domain'

vi.mock('../daemon/daemon-cgroup-scope', () => ({ isDurableDaemonScopeSupported: () => true }))
vi.mock('../ipc/command-path-resolver', () => ({
  resolveCommandOnLocalPath: async () => '/synthetic/check'
}))
vi.mock('./automation-linux-cgroup-command', () => ({
  executeLinuxCgroupAutomationCommand: vi.fn(async () => ({ verdict: 'unverifiable' as const })),
  cancelLinuxCgroupAutomationCommand: vi.fn(),
  cancelLinuxCgroupAutomationAgent: vi.fn()
}))
vi.mock('./automation-linux-cgroup-lifecycle', () => ({
  provePriorCommandChildExited: vi.fn(() => true)
}))

function fixture() {
  const input = commandRetryFixture()
  const isCurrentOwner = vi.fn(() => true)
  const adapter = createLinuxCommandAutomationAdapter({
    store: {
      getCommandAutomationClaim: () => input.readClaim(),
      listAutomationRuns: () => input.state.automationRuns
    },
    hostGeneration: 3,
    isCurrentOwner,
    runs: {
      bindCommandProcessIntent: vi.fn(),
      recordCommandExitProof: vi.fn(),
      bindAgentProcessIntent: vi.fn(),
      recordAgentExitProof: vi.fn()
    },
    resolveExistingWorkspaceCwd: async () => '/synthetic/folder',
    reportDelivery: { supportsTarget: async () => true, deliver: async () => true }
  })
  return { ...input, adapter, isCurrentOwner }
}

describe.skipIf(process.platform !== 'linux')('Linux retry admission and gate authority', () => {
  it('admits idempotent command-only retries for a folder workspace and refuses SSH/agents', async () => {
    const input = fixture()
    expect(input.definition.workspaceId).toBeNull()
    expect(await input.adapter.supportsDefinition(input.definition)).toBe(true)
    expect(
      await input.adapter.supportsDefinition({
        ...input.definition,
        executionTargetType: 'ssh',
        executionTargetId: 'ssh-fixture'
      })
    ).toBe(false)
    expect(
      await input.adapter.supportsDefinition({
        ...input.definition,
        execution: {
          ...input.definition.execution,
          agent: { agentId: 'codex', prompt: 'Review', sessionPolicy: 'ephemeral' }
        }
      })
    ).toBe(false)
  })

  it('uses the current persisted receipt for physical proof and refuses stale or lost-owner proof', () => {
    const input = fixture()
    expect(input.adapter.provePriorCommandExit?.(input.claim)).toBe(true)
    expect(provePriorCommandChildExited).toHaveBeenLastCalledWith(input.readClaim())
    expect(input.adapter.provePriorCommandExit?.({ ...input.claim, acquisitionId: 'stale' })).toBe(
      false
    )
    input.isCurrentOwner.mockReturnValue(false)
    expect(input.adapter.provePriorCommandExit?.(input.claim)).toBe(false)
  })

  it.each(['owner', 'acquisition', 'generation', 'cancel', 'revision'] as const)(
    'refuses gate release after %s changes',
    async (kind) => {
      const input = fixture()
      const domain = readAutomationCommandsV1Domain(input.state.automationCommandsV1)
      const current = domain.activeClaims[0]
      if (!current.processIntent) {
        throw new Error('Missing intent')
      }
      current.processIntent.execMayHappen = true
      input.state.automationCommandsV1 = domain
      await input.adapter.executeCommand(input.definition, input.claim)
      const call = vi.mocked(executeLinuxCgroupAutomationCommand).mock.lastCall?.[0]
      if (!call) {
        throw new Error('Executor was not reached')
      }
      expect(await call.mayReleaseGate()).toBe(true)
      if (kind === 'owner') {
        input.isCurrentOwner.mockReturnValue(false)
      }
      if (kind === 'acquisition') {
        current.acquisitionId = 'stale'
      }
      if (kind === 'generation') {
        current.hostGeneration = 4
      }
      if (kind === 'cancel') {
        current.cancelRequestedAt = current.createdAt + 1
      }
      if (kind === 'revision') {
        current.definitionRevision = 2
      }
      expect(await call.mayReleaseGate()).toBe(false)
    }
  )
})
