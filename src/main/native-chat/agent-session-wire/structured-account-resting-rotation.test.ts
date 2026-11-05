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
  const records = new Map([[record.sessionId, record]])
  const residents = new Set([record.sessionId])
  const stop = vi.fn(async () => {})
  const shouldRest = vi.fn(async () => true)
  const installed = installStructuredAccountRestingRotation({
    subscribeState: (listener) => {
      stateChanged = listener
    },
    subscribe: (next) => {
      subscriber = next
      return () => {}
    },
    residentSessionIds: () => residents,
    readRecord: (id) => records.get(id) ?? null,
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
    records,
    residents,
    pending: () => installed?.pendingCountForTests() ?? 0,
    stop,
    shouldRest,
    emit: async (id = record.sessionId) => {
      subscriber?.emit({
        type: 'completion',
        completion: {
          sessionId: id,
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

it('does not retain a thousand permanently unneeded historic completion pairs', async () => {
  const f = fixture()
  f.shouldRest.mockResolvedValue(false)
  for (let i = 0; i < 1000; i++) {
    const record = agentSessionRecordFixture()
    record.sessionId = `resident-${i}`
    f.records.set(record.sessionId, record)
    f.residents.add(record.sessionId)
    await f.emit(record.sessionId)
    f.residents.delete(record.sessionId)
  }
  expect(f.pending()).toBe(0)
  expect(f.stop).not.toHaveBeenCalled()
})
it('reseeds the current resident on policy enablement after clearing an unneeded completion', async () => {
  const f = fixture()
  f.shouldRest.mockResolvedValue(false)
  await f.emit()
  expect(f.pending()).toBe(0)
  f.shouldRest.mockResolvedValue(true)
  await f.stateChanged()
  expect(f.stop).toHaveBeenCalledOnce()
})
it('retains transient child-settlement work and prunes it once the resident closes', async () => {
  const f = fixture()
  f.boundary.canRest = false
  await f.emit()
  expect(f.pending()).toBe(1)
  f.residents.clear()
  await f.stateChanged()
  expect(f.pending()).toBe(0)
  expect(f.stop).not.toHaveBeenCalled()
})
