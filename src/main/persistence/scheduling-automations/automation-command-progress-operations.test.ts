import { describe, expect, it, vi } from 'vitest'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import {
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
})
