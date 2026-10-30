import { describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import { installStructuredAccountRestingRotation } from './structured-account-resting-rotation'
import type { NativeAccountRotationBoundary } from './structured-account-acquisition'
import type { StructuredAgentSessionTurnCompletionSubscriber } from './structured-agent-session-turn-completion-feed'
function fixture() {
  let subscriber: StructuredAgentSessionTurnCompletionSubscriber | undefined
  let operation = Promise.resolve()
  let stateChanged: (() => void) | undefined
  const boundary: NativeAccountRotationBoundary = {
    lastCompletedTurn: { id: 'turn', outcome: 'success' },
    childrenSettled: true,
    canRotate: true,
    canRest: true
  }
  const record = agentSessionRecordFixture()
  const stop = vi.fn(async () => {})
  const shouldRest = vi.fn(async () => true)
  installStructuredAccountRestingRotation({
    subscribeState: (listener) => {
      stateChanged = listener
    },
    subscribe: (next) => {
      subscriber = next
      return () => {}
    },
    readRecord: () => record,
    readBoundary: () => boundary,
    shouldRest,
    stop,
    serialize: async (_id, task) => task(),
    track: (task) => {
      operation = task
      return task
    },
    failed: (error) => {
      throw error
    }
  })
  return {
    stateChanged: async () => {
      await Promise.resolve()
      stateChanged?.()
      await operation
    },
    boundary,
    record,
    stop,
    shouldRest,
    emit: async () => {
      subscriber?.emit({
        type: 'completion',
        completion: {
          sessionId: record.sessionId,
          scope: record.location,
          turnId: 'turn',
          outcome: 'success',
          completedAt: 3000
        }
      })
      await operation
    }
  }
}
describe('native pool resting rotation', () => {
  it('evicts only a completed idle generation approved by the pool selector', async () => {
    const f = fixture()
    await f.emit()
    expect(f.stop).toHaveBeenCalledOnce()
  })
  it('keeps an idle provider when no replacement account is eligible', async () => {
    const f = fixture()
    f.shouldRest.mockResolvedValue(false)
    await f.emit()
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('rechecks pending work after asynchronous policy evaluation', async () => {
    const f = fixture()
    f.shouldRest.mockImplementation(async () => {
      f.boundary.canRest = false
      return true
    })
    await f.emit()
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('waits for child settlement after the live completion without replaying history', async () => {
    const f = fixture()
    f.boundary.canRest = false
    await f.emit()
    expect(f.stop).not.toHaveBeenCalled()
    f.boundary.canRest = true
    await f.stateChanged()
    expect(f.stop).toHaveBeenCalledOnce()
  })
  it('does not mistake a rejected send for the previous completed turn', async () => {
    const f = fixture()
    f.boundary.lastCompletedTurn = null
    await f.emit()
    expect(f.stop).not.toHaveBeenCalled()
  })
})
