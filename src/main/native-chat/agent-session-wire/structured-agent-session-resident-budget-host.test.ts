import { expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { NativeAccountRotationBoundary } from './structured-account-acquisition'
import {
  createStructuredResidentBudget,
  installStructuredResidentBudget
} from './structured-agent-session-resident-budget-host'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'

function fixture() {
  const records = Array.from({ length: 12 }, (_, i) => {
    const record = agentSessionRecordFixture()
    record.sessionId = String(i)
    record.provider = i % 2 ? 'claude' : 'codex'
    record.lease.claimStatus = 'live'
    return record
  })
  const sessions = Object.assign(
    new Map(
      records.map((record) => [
        record.sessionId,
        {
          child: { fence: record.lease.runtimeFence, phase: 'ready' as const },
          operationalRevision: 0
        }
      ])
    ),
    { lastActivityAt: (id: string) => Number(id) }
  )
  const boundary: NativeAccountRotationBoundary = {
    canRest: true,
    canRotate: true,
    childrenSettled: true,
    lastCompletedTurn: { id: 'turn', outcome: 'success' }
  }
  const rest = vi.fn(async (id: string) => {
    sessions.delete(id)
  })
  records[2].lease.claimStatus = 'released'
  records[3].providerHandleChain = []
  const options: Parameters<typeof createStructuredResidentBudget>[0] = {
    context: () => ({
      deps: {
        store: { getRecord: (id) => records.find((r) => r.sessionId === id) ?? null },
        logger: { warn: vi.fn() }
      }
    }),
    sessions,
    hasReaders: (id) => id === '0',
    hasOpenWork: (id) => id === '1',
    readBoundary: (id) =>
      id === '4'
        ? { ...boundary, canRest: false }
        : id === '5'
          ? { ...boundary, childrenSettled: false }
          : boundary,
    serialize: async (_id, task) => task(),
    rest,
    isDisposed: () => false
  }
  return { options, rest, sessions }
}
it('uses current ownership, native history, work and reader proof across both providers', async () => {
  const { options, rest, sessions } = fixture()
  await createStructuredResidentBudget(options).tick()
  expect(rest.mock.calls.map(([id]) => id)).toEqual(['6', '7'])
  expect([...sessions.keys()].slice(0, 6)).toEqual(['0', '1', '2', '3', '4', '5'])
})

it('revokes new pressure on shutdown and drains an admitted rest before journal disposal', async () => {
  const { options, rest } = fixture()
  const tasks = new StructuredAgentSessionTaskQueue()
  let release = () => {}
  const settling = new Promise<void>((resolve) => {
    release = resolve
  })
  rest.mockImplementation(async () => settling)
  const installed = installStructuredResidentBudget({
    ...options,
    subscribeCompletions: () => () => {},
    track: (operation) => tasks.trackAttach(operation)
  })
  void installed.tick()
  await vi.waitFor(() => expect(rest).toHaveBeenCalledOnce())
  installed.dispose()
  let drained = false
  const shutdown = tasks.drainAttaches().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  release()
  await shutdown
  expect(drained).toBe(true)
  await installed.tick()
  expect(rest).toHaveBeenCalledOnce()
})
