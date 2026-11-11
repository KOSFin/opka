import { describe, expect, it, vi } from 'vitest'
import type { AutomationCommandObservation } from '../../shared/automation-command-execution'
import { runClaimedAutomationCommand } from './automation-command-runner'
import { commandRetryFixture, failedCommand, RETRY_NOW } from './automation-command-retry-fixture'

function pipeline(observations: AutomationCommandObservation[]) {
  const input = commandRetryFixture()
  const adapter = {
    executeCommand: vi.fn(async () => {
      const observation = observations.shift()
      if (!observation) {
        throw new Error('Unexpected third child')
      }
      input.persistExit(observation)
      return { verdict: 'exited' as const, observation }
    }),
    provePriorCommandExit: vi.fn(() => true),
    isCancelRequested: vi.fn(() => false),
    deliverReport: vi.fn(async () => true),
    now: () => RETRY_NOW + 2
  }
  return { ...input, adapter }
}
const success = { ...failedCommand, exitCode: 0, stdout: '{"version":1,"changed":true}' }

describe('safe command retry pipeline', () => {
  it.each([success, failedCommand])(
    'executes only two children and reports the final result once: %j',
    async (final) => {
      const input = pipeline([failedCommand, final])
      const result = await runClaimedAutomationCommand(input)
      expect(input.adapter.executeCommand).toHaveBeenCalledTimes(2)
      expect(input.runs.retryCommandRun).toHaveBeenCalledOnce()
      expect(input.adapter.deliverReport).toHaveBeenCalledOnce()
      expect(result.run).toMatchObject({
        id: input.claim.runId,
        createdAt: RETRY_NOW,
        status: final.exitCode === 0 ? 'completed' : 'dispatch_failed',
        commandExecution: { attempt: 2 }
      })
      expect(input.readClaim()).toMatchObject({
        runId: input.claim.runId,
        createdAt: RETRY_NOW,
        attempt: 2,
        overlapCount: 2,
        runSnapshot: input.claim.runSnapshot
      })
      expect(input.readClaim().acquisitionId).not.toBe(input.claim.acquisitionId)
      expect(input.state.automationRuns).toHaveLength(1)
    }
  )

  it.each([
    { ...failedCommand, exitCode: null },
    { ...failedCommand, exitCode: 1.5 },
    { ...failedCommand, timedOut: true },
    { ...failedCommand, error: 'launch error' },
    { ...success, stdout: '{"version":1,"changed":false}' },
    { ...success, stdout: 'malformed' }
  ])('does not retry an ineligible observation: %j', async (observation) => {
    const input = pipeline([observation])
    // Malformed exit codes cannot enter the durable domain; use an adapter observation only.
    if (observation.exitCode === 1.5) {
      input.adapter.executeCommand.mockImplementation(async () => ({
        verdict: 'exited',
        observation
      }))
    }
    await runClaimedAutomationCommand(input)
    expect(input.adapter.executeCommand).toHaveBeenCalledOnce()
    expect(input.runs.retryCommandRun).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'deadline', 'unverifiable', 'throw', 'max1', 'agent', 'no-proof'] as const)(
    'does not retry after %s',
    async (kind) => {
      const input = pipeline([failedCommand])
      if (kind === 'cancel') {
        input.adapter.isCancelRequested.mockReturnValue(true)
      }
      if (kind === 'deadline') {
        input.adapter.now = () => RETRY_NOW + 90_000
      }
      if (kind === 'throw') {
        input.adapter.executeCommand.mockRejectedValue(new Error('lost contact'))
      }
      if (kind === 'unverifiable') {
        input.adapter.provePriorCommandExit.mockReturnValue(false)
      }
      if (kind === 'max1') {
        input.definition.execution.policy = {
          ...input.definition.execution.policy,
          maxAttempts: 1,
          idempotent: false
        }
      }
      if (kind === 'agent') {
        input.definition = {
          ...input.definition,
          execution: {
            ...input.definition.execution,
            agent: { agentId: 'codex', prompt: 'Review', sessionPolicy: 'ephemeral' }
          }
        }
      }
      if (kind === 'no-proof') {
        input.adapter.executeCommand.mockImplementation(async () => ({
          verdict: 'exited',
          observation: failedCommand
        }))
      }
      await (kind === 'no-proof'
        ? expect(runClaimedAutomationCommand(input)).rejects.toThrow('retry is not authorized')
        : runClaimedAutomationCommand(input))
      expect(input.adapter.executeCommand).toHaveBeenCalledOnce()
      if (kind !== 'no-proof') {
        expect(input.runs.retryCommandRun).not.toHaveBeenCalled()
      }
    }
  )

  it('resumes a retained failed condition by executing only its newly committed attempt', async () => {
    const input = pipeline([success])
    input.persistExit(failedCommand)
    await input.runs.advanceCommandRun(input.fence, { phase: 'condition', observation: 'exited' })
    const restored = structuredClone(input.readClaim())
    const result = await runClaimedAutomationCommand({ ...input, claim: restored })
    expect(input.adapter.executeCommand).toHaveBeenCalledOnce()
    expect(input.runs.retryCommandRun).toHaveBeenCalledOnce()
    expect(result.run.commandExecution).toMatchObject({ attempt: 2, phase: 'settled' })
  })

  it.each([false, true])(
    'waits for retry acknowledgement before a second child, rejected=%s',
    async (rejected) => {
      const input = pipeline([failedCommand, success])
      const acknowledgement = Promise.withResolvers<ReturnType<typeof input.readClaim>>()
      input.runs.retryCommandRun.mockReturnValue(acknowledgement.promise)
      const pending = runClaimedAutomationCommand(input)
      await vi.waitFor(() => expect(input.runs.retryCommandRun).toHaveBeenCalledOnce())
      expect(input.adapter.executeCommand).toHaveBeenCalledOnce()
      if (rejected) {
        acknowledgement.reject(new Error('uncertain flush'))
        await expect(pending).rejects.toThrow('uncertain flush')
        expect(input.adapter.executeCommand).toHaveBeenCalledOnce()
        expect(input.adapter.deliverReport).not.toHaveBeenCalled()
      } else {
        const { retryAutomationCommandRun } =
          await import('../persistence/scheduling-automations/automation-command-retry-operations')
        const fence = { ...input.fence, expectedPhase: 'condition' as const }
        acknowledgement.resolve(retryAutomationCommandRun(input.operations, fence, RETRY_NOW + 2))
        await pending
        expect(input.adapter.executeCommand).toHaveBeenCalledTimes(2)
        expect(input.adapter.deliverReport).toHaveBeenCalledOnce()
      }
    }
  )
})
