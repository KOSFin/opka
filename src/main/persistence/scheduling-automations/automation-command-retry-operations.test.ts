import { describe, expect, it, vi } from 'vitest'
import {
  commandRetryFixture,
  failedCommand,
  RETRY_NOW
} from '../../automations/automation-command-retry-fixture'
import { readAutomationCommandsV1Domain } from '../../../shared/automation-command-domain'
import {
  advanceAutomationCommandRun,
  adoptProvenAutomationCommandCondition
} from './automation-command-progress-operations'
import {
  bindAutomationCommandProcessIntent,
  recordAutomationCommandExitProof
} from './automation-command-process-operations'
import { retryAutomationCommandRun } from './automation-command-retry-operations'
import { recoverActiveAutomationCommandRuns } from '../loading-store/automation-command-run-recovery'

function proven() {
  const input = commandRetryFixture()
  input.persistExit(failedCommand)
  advanceAutomationCommandRun(input.operations, input.fence, {
    phase: 'condition',
    observation: 'exited'
  })
  return { ...input, fence: { ...input.fence, expectedPhase: 'condition' as const } }
}

describe('durable command retry transition', () => {
  it('atomically rotates acquisition and intent while preserving run/manual/occurrence/overlap identity', () => {
    const input = proven()
    const before = readAutomationCommandsV1Domain(input.state.automationCommandsV1)
    input.operations.flush.mockClear()
    const next = retryAutomationCommandRun(input.operations, input.fence, RETRY_NOW + 2)
    const after = readAutomationCommandsV1Domain(input.state.automationCommandsV1)
    expect(next).toMatchObject({
      ...input.claim,
      attempt: 2,
      phase: 'command',
      observation: 'unverifiable',
      acquisitionId: expect.any(String),
      processIntent: {
        backend: 'linux_cgroup_v1',
        childName: 'command',
        unitName: `orca-automation-${next.acquisitionId}.scope`
      }
    })
    expect(next.acquisitionId).not.toBe(input.claim.acquisitionId)
    expect(next.processIntent?.receiptDirectory).not.toBe(
      input.claim.processIntent?.receiptDirectory
    )
    expect(next.processIntent).not.toHaveProperty('execMayHappen')
    expect(next.processIntent).not.toHaveProperty('exitProof')
    expect(after.manualReceipts).toEqual(before.manualReceipts)
    expect(after.definitions).toEqual(before.definitions)
    expect(after.activeClaims).toHaveLength(1)
    expect(input.state.automationRuns).toHaveLength(1)
    expect(input.state.automationRuns[0].commandExecution).toMatchObject({
      phase: 'command',
      attempt: 2,
      overlapCount: 2
    })
    expect(input.operations.flush).toHaveBeenCalledOnce()
    expect(() => retryAutomationCommandRun(input.operations, input.fence, RETRY_NOW + 3)).toThrow(
      'acquisition changed'
    )
    const staleCommandFence = { ...input.fence, expectedPhase: 'command' as const }
    expect(() =>
      bindAutomationCommandProcessIntent(input.operations, staleCommandFence, {
        childCgroupPath: '/sys/fs/cgroup/old/command',
        blockedChildPid: 42,
        blockedChildStartTime: '500'
      })
    ).toThrow('acquisition changed')
    expect(() =>
      recordAutomationCommandExitProof(
        input.operations,
        staleCommandFence,
        failedCommand,
        RETRY_NOW + 3
      )
    ).toThrow('acquisition changed')
  })

  it.each([
    'zero',
    'null',
    'timeout',
    'error',
    'cancel',
    'epoch',
    'revision',
    'agent',
    'max1',
    'idempotent',
    'deadline',
    'phase',
    'unbound'
  ] as const)('refuses %s without consuming an attempt', (kind) => {
    const input = proven()
    const domain = readAutomationCommandsV1Domain(input.state.automationCommandsV1)
    const claim = domain.activeClaims[0]
    const definition = domain.definitions[0]
    if (!claim.processIntent?.exitProof) {
      throw new Error('Missing test proof')
    }
    if (kind === 'zero') {
      claim.processIntent.exitProof.exitCode = 0
    }
    if (kind === 'null') {
      claim.processIntent.exitProof.exitCode = null
    }
    if (kind === 'timeout') {
      claim.processIntent.exitProof.timedOut = true
    }
    if (kind === 'error') {
      claim.processIntent.exitProof.error = 'lost contact'
    }
    if (kind === 'cancel') {
      claim.cancelRequestedAt = RETRY_NOW + 1
    }
    if (kind === 'epoch') {
      domain.hostEpoch = 4
    }
    if (kind === 'revision') {
      definition.revision = 2
    }
    if (kind === 'agent') {
      claim.agentIntent = { ...claim.processIntent, childName: 'agent' }
    }
    if (kind === 'max1') {
      definition.execution.policy.maxAttempts = 1
    }
    // Invalid max2 policies are rejected by domain validation before the retry guard.
    if (kind === 'idempotent') {
      definition.execution.policy.idempotent = false
    }
    if (kind === 'phase') {
      claim.phase = 'report'
    }
    if (kind === 'unbound') {
      delete claim.processIntent.execMayHappen
    }
    input.state.automationCommandsV1 = domain
    input.operations.flush.mockClear()
    expect(() =>
      retryAutomationCommandRun(
        input.operations,
        input.fence,
        RETRY_NOW + (kind === 'deadline' ? 90_000 : 2)
      )
    ).toThrow()
    expect(input.operations.flush).not.toHaveBeenCalled()
    expect(input.state.automationCommandsV1).toMatchObject({ activeClaims: [{ attempt: 1 }] })
  })

  it('requires explicit proven-condition adoption before a new epoch can consume the retry', () => {
    const input = proven()
    input.state.automationCommandsV1 = {
      ...readAutomationCommandsV1Domain(input.state.automationCommandsV1),
      hostEpoch: 4
    }
    expect(() => retryAutomationCommandRun(input.operations, input.fence, RETRY_NOW + 2)).toThrow(
      'not authorized'
    )
    const adopted = adoptProvenAutomationCommandCondition(input.operations, input.fence, 4)
    const next = retryAutomationCommandRun(
      input.operations,
      { ...input.fence, hostGeneration: adopted.hostGeneration },
      RETRY_NOW + 2
    )
    expect(next).toMatchObject({ hostGeneration: 4, attempt: 2 })
  })

  it.each([false, true])(
    'restart preserves consumed attempt and fresh intent, released=%s',
    (released) => {
      const input = proven()
      const beforeCommit = structuredClone(input.state)
      expect(
        readAutomationCommandsV1Domain(beforeCommit.automationCommandsV1).activeClaims[0]
      ).toMatchObject({ attempt: 1, phase: 'condition' })
      const next = retryAutomationCommandRun(input.operations, input.fence, RETRY_NOW + 2)
      if (released) {
        bindAutomationCommandProcessIntent(
          input.operations,
          { ...input.fence, acquisitionId: next.acquisitionId, expectedPhase: 'command' },
          {
            childCgroupPath: `/sys/fs/cgroup/${next.processIntent?.unitName}/command`,
            blockedChildPid: 43,
            blockedChildStartTime: '501'
          }
        )
      }
      const restarted = structuredClone(input.state)
      restarted.automationCommandsV1 = readAutomationCommandsV1Domain(
        JSON.parse(JSON.stringify(input.state.automationCommandsV1))
      )
      const runs = recoverActiveAutomationCommandRuns(restarted, restarted.automationRuns, vi.fn())
      const retained = readAutomationCommandsV1Domain(restarted.automationCommandsV1)
        .activeClaims[0]
      expect(retained).toMatchObject({
        attempt: 2,
        acquisitionId: next.acquisitionId,
        createdAt: RETRY_NOW
      })
      expect(retained.processIntent?.execMayHappen).toBe(released ? true : undefined)
      expect(runs[0].commandExecution).toMatchObject({ attempt: 2, phase: 'unverifiable' })
      expect(() =>
        retryAutomationCommandRun(
          { ...input.operations, state: restarted },
          {
            ...input.fence,
            acquisitionId: next.acquisitionId,
            expectedPhase: 'command'
          },
          RETRY_NOW + 3
        )
      ).toThrow('not authorized')
    }
  )
})
