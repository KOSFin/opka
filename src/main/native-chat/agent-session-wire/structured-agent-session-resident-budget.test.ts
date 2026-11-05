import { expect, it, vi } from 'vitest'
import {
  StructuredAgentSessionResidentBudget,
  type InactiveStructuredResident
} from './structured-agent-session-resident-budget'
function fixture(count = 7) {
  const rows = new Map<string, InactiveStructuredResident>(
    Array.from({ length: count }, (_, i) => {
      const sessionId = String(i)
      return [sessionId, { sessionId, child: {}, revision: 0, lastActivityAt: i }]
    })
  )
  const protectedIds = new Set<string>()
  const failed = vi.fn()
  const rest = vi.fn(async (id: string) => {
    rows.delete(id)
  })
  const budget = new StructuredAgentSessionResidentBudget({
    candidates: () => [...rows.values()].filter((row) => !protectedIds.has(row.sessionId)),
    serialize: async (_id, task) => task(),
    rest,
    stillResident: (row) => rows.get(row.sessionId)?.child === row.child,
    failed
  })
  return { rows, protectedIds, failed, rest, budget }
}
it('rests only oldest eligible backends to four', async () => {
  const f = fixture()
  await f.budget.tick()
  expect(f.rest.mock.calls.map(([id]) => id)).toEqual(['0', '1', '2'])
  expect([...f.rows.keys()]).toEqual(['3', '4', '5', '6'])
})
it('protected residents do not count toward or get evicted by the inactive budget', async () => {
  const f = fixture(9)
  f.protectedIds.add('0').add('1')
  await f.budget.tick()
  expect(f.rest.mock.calls.map(([id]) => id)).toEqual(['2', '3', '4'])
  expect(f.rows.has('0') && f.rows.has('1')).toBe(true)
})
it.each(['viewer', 'new-child', 'revision', 'activity'] as const)(
  'rechecks %s inside serialization',
  async (change) => {
    const f = fixture(5)
    const first = f.rows.get('0')!
    const rest = vi.fn(async (id: string) => {
      f.rows.delete(id)
    })
    const budget = new StructuredAgentSessionResidentBudget({
      candidates: () => [...f.rows.values()].filter((row) => !f.protectedIds.has(row.sessionId)),
      serialize: async (id, task) => {
        if (id === '0') {
          if (change === 'viewer') {
            f.protectedIds.add(id)
          }
          if (change === 'new-child') {
            f.rows.set(id, { ...first, child: {} })
          }
          if (change === 'revision') {
            f.rows.set(id, { ...first, revision: 1 })
          }
          if (change === 'activity') {
            f.rows.set(id, { ...first, lastActivityAt: 100 })
          }
        }
        return task()
      },
      rest,
      stillResident: (row) => f.rows.get(row.sessionId)?.child === row.child,
      failed: f.failed
    })
    await budget.tick()
    expect(rest).not.toHaveBeenCalledWith('0')
  }
)
it('never retries an unproven oldest stop within a pass or counts it as freed', async () => {
  const f = fixture(6)
  f.rest.mockImplementation(async (id) => {
    if (id === '0') {
      throw new Error('unverifiable')
    }
    f.rows.delete(id)
  })
  await f.budget.tick()
  expect(f.rest.mock.calls.map(([id]) => id)).toEqual(['0', '1', '2'])
  expect(f.rows.has('0')).toBe(true)
  expect(f.failed).toHaveBeenCalledOnce()
})
it('bounds failed attempts and coalesces simultaneous pressure requests', async () => {
  const f = fixture(100)
  f.rest.mockRejectedValue(new Error('unverifiable'))
  await Promise.all([f.budget.tick(), f.budget.tick(), f.budget.tick()])
  expect(f.rest).toHaveBeenCalledTimes(16)
  expect(new Set(f.rest.mock.calls.map(([id]) => id)).size).toBe(16)
})
it('stops admitting pressure work once disposed', async () => {
  const f = fixture()
  const work = f.budget.tick()
  f.budget.dispose()
  await work
  await f.budget.tick()
  expect(f.rest).not.toHaveBeenCalled()
})
