import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { resolveWorkerConcurrencyLimit } from '../../../shared/worker-concurrency-limit'

let db: OrchestrationDb | undefined
afterEach(() => {
  db?.close()
  db = undefined
})
function fixture() {
  const store = new OrchestrationDb(':memory:')
  db = store
  const start = (
    limit?: number,
    federation?: Parameters<typeof store.createStartingWorkerDispatch>[0]['federation']
  ) =>
    store.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 2,
      taskSpec: 'Synthetic worker',
      taskRunId: 'run_legacy_local',
      startOptions: {},
      maxConcurrentWorkers: limit,
      federation
    })
  return { store, start }
}
it('reserves the last slot atomically before creating another task or dispatch', () => {
  const { store, start } = fixture()
  start(1)
  const tasks = store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.n
  expect(() => start(1)).toThrow(/active or unverifiable/)
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.n).toBe(tasks)
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM worker_dispatches').get()?.n).toBe(1)
})
it.each(['starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown'])(
  'retains capacity for %s until the owning lifecycle settles',
  (state) => {
    const { store, start } = fixture()
    const first = start(1)
    store.db
      .prepare('UPDATE worker_dispatches SET state=? WHERE dispatch_id=?')
      .run(state, first.dispatch.id)
    expect(() => start(1)).toThrow(/active or unverifiable/)
    store.db
      .prepare("UPDATE worker_dispatches SET state='stopping' WHERE dispatch_id=?")
      .run(first.dispatch.id)
    store.settleWorkerStop(first.dispatch.id)
    expect(start(1).worker.state).toBe('starting')
  }
)
it('excludes workers sent to another host but includes incoming attachments', () => {
  const { store, start } = fixture()
  start(1, {
    environmentId: 'remote',
    environmentName: 'Synthetic',
    peerFingerprint: 'peer',
    protocolVersion: 1
  })
  store.createRemoteDispatchAttachment({
    dispatchId: 'ctx_remote',
    taskId: 'task_remote',
    homePeerFingerprint: 'peer',
    protocolVersion: 1,
    runtimeEpoch: 'test',
    maxConcurrentWorkers: 1,
    mutationReceipt: {
      callerFingerprint: 'peer',
      requestId: 'one',
      method: 'start',
      payloadHash: 'hash'
    }
  })
  expect(() => start(1)).toThrow(/active or unverifiable/)
  expect(() =>
    store.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote_two',
      taskId: 'task_remote_two',
      homePeerFingerprint: 'peer',
      protocolVersion: 1,
      runtimeEpoch: 'test',
      maxConcurrentWorkers: 1,
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'two',
        method: 'start',
        payloadHash: 'hash'
      }
    })
  ).toThrow(/active or unverifiable/)
})
it('leaves old hosts unlimited and rejects invalid explicit operator settings', () => {
  const { start } = fixture()
  for (let i = 0; i < 6; i++) {
    start()
  }
  expect(resolveWorkerConcurrencyLimit(null)).toBeUndefined()
  expect(resolveWorkerConcurrencyLimit(undefined)).toBeUndefined()
  for (const value of [0, -1, 1.5, '5', Number.NaN]) {
    expect(() => resolveWorkerConcurrencyLimit(value)).toThrow(/positive integer/)
  }
})

it('shares reservations across database connections and reopening without reclaiming unknown work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opka-worker-capacity-'))
  const path = join(root, 'runtime.db')
  const first = new OrchestrationDb(path)
  let second: OrchestrationDb | undefined
  try {
    const input = {
      creator: { kind: 'system' as const },
      maxDepth: 2,
      maxConcurrentWorkers: 1,
      taskSpec: 'Synthetic worker',
      taskRunId: 'run_legacy_local',
      startOptions: {}
    }
    first.createStartingWorkerDispatch(input)
    second = new OrchestrationDb(path)
    expect(() => second?.createStartingWorkerDispatch(input)).toThrow(/active or unverifiable/)
    expect(second.db.prepare('SELECT COUNT(*) AS n FROM worker_dispatches').get()?.n).toBe(1)
  } finally {
    second?.close()
    first.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('preserves mutation replay authority when the host is at capacity', () => {
  const { store } = fixture()
  const input = {
    creator: { kind: 'system' as const },
    maxDepth: 2,
    maxConcurrentWorkers: 1,
    taskSpec: 'Synthetic worker',
    taskRunId: 'run_legacy_local',
    startOptions: {},
    mutationReceipt: {
      callerFingerprint: 'local',
      requestId: 'same-request',
      method: 'start',
      payloadHash: 'hash'
    }
  }
  store.createStartingWorkerDispatch(input)
  expect(() => store.createStartingWorkerDispatch(input)).toThrow(/durable acceptance record/)
})
