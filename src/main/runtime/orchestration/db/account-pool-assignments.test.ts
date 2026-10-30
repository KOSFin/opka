import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import type { AcquireAccountPoolAssignment } from './account-pool-assignments'

let db: OrchestrationDb | undefined
afterEach(() => db?.close())
function fixture() {
  const store = new OrchestrationDb(':memory:')
  db = store
  const args: AcquireAccountPoolAssignment = {
    ownerKey: 'pty:synthetic:generation-1',
    policy: {
      id: 'pool',
      provider: 'claude',
      revision: 1,
      strategy: 'balanced',
      applyToNewWork: false,
      rotation: 'off',
      unknownQuota: 'allow',
      allowReserve: false,
      members: ['a', 'b'].map((accountId) => ({
        accountId,
        priority: 1,
        weight: 1,
        maxConcurrent: 1,
        state: 'enabled',
        role: 'primary'
      }))
    },
    candidates: ['a', 'b'].map((accountId) => ({
      accountId,
      quotaIdentity: accountId,
      auth: 'ready',
      quota: 'unknown',
      usedPercent: null
    }))
  }
  return { store, args }
}
it('keeps retries on the same fixed identity after a policy edit', () => {
  const { store, args } = fixture()
  const first = store.acquireAccountPoolAssignment(args)
  args.policy.revision = 2
  args.policy.members.reverse()
  expect(store.acquireAccountPoolAssignment(args)).toEqual(first)
  expect(store.listAccountPoolAssignments()).toHaveLength(1)
})
it('shares ordinary and worker slots atomically and releases only host-settled work', () => {
  const { store, args } = fixture()
  const first = store.acquireAccountPoolAssignment(args)
  const worker = store.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 2,
    taskSpec: 'Synthetic worker',
    taskRunId: 'run_legacy_local',
    startOptions: {},
    accountPoolAdmission: args
  })
  expect(JSON.parse(worker.worker.start_options).account.id).not.toBe(first.accountId)
  expect(() => store.acquireAccountPoolAssignment({ ...args, ownerKey: 'native:other' })).toThrow(
    /No eligible account/
  )
  store.db
    .prepare("UPDATE worker_dispatches SET state='stop_unknown' WHERE dispatch_id=?")
    .run(worker.dispatch.id)
  expect(store.listAccountPoolAssignments()).toHaveLength(2)
  store.db
    .prepare("UPDATE worker_dispatches SET state='stopped' WHERE dispatch_id=?")
    .run(worker.dispatch.id)
  expect(store.listAccountPoolAssignments()).toHaveLength(1)
  expect(
    store.acquireAccountPoolAssignment({ ...args, ownerKey: 'native:other' }).accountId
  ).not.toBe(first.accountId)
})
it('explicit release cannot reuse a previous owner generation', () => {
  const { store, args } = fixture()
  store.acquireAccountPoolAssignment(args)
  store.releaseAccountPoolAssignment(args.ownerKey)
  expect(store.listAccountPoolAssignments()).toEqual([])
  expect(() => store.acquireAccountPoolAssignment(args)).toThrow(/new execution generation/)
  expect(
    store.acquireAccountPoolAssignment({ ...args, ownerKey: 'pty:synthetic:generation-2' }).sequence
  ).toBeGreaterThan(1)
})
it('unlimited membership does not impose an undocumented concurrency default', () => {
  const { store, args } = fixture()
  args.policy.members = [{ ...args.policy.members[0], maxConcurrent: undefined }]
  for (let index = 0; index < 6; index++) {
    store.acquireAccountPoolAssignment({ ...args, ownerKey: `native:${index}` })
  }
  expect(store.listAccountPoolAssignments()).toHaveLength(6)
})

it('persists exact terminal-generation correlation and refuses rebinding', () => {
  const { store, args } = fixture()
  store.acquireAccountPoolAssignment(args)
  store.bindAccountPoolAssignmentPty({
    ownerKey: args.ownerKey,
    ptyId: 'pty-a',
    incarnationId: 'generation-a'
  })
  expect(store.listAccountPoolAssignments()[0]).toMatchObject({
    ptyId: 'pty-a',
    incarnationId: 'generation-a'
  })
  expect(() =>
    store.bindAccountPoolAssignmentPty({
      ownerKey: args.ownerKey,
      ptyId: 'pty-a',
      incarnationId: 'generation-b'
    })
  ).toThrow(/another terminal generation/)
})
