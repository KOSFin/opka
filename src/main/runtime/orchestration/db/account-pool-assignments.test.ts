import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import {
  ACCOUNT_POOL_ASSIGNMENTS_SQL,
  type AcquireAccountPoolAssignment
} from './account-pool-assignments'

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
it('persists the host quota decision explanation with its selected assignment', () => {
  const { store, args } = fixture()
  args.policy.provider = 'codex'
  args.policy.strategy = 'quota-equalize'
  args.candidates[0].quota = 'available'
  args.candidates[0].quotaWindows = [
    {
      windowMinutes: 10080,
      verifiedDurationMinutes: 10080,
      usedPercent: 50,
      resetsAt: Date.now() + 86_400_000
    }
  ]
  args.candidates[1].quota = 'available'
  args.candidates[1].quotaWindows = [
    {
      windowMinutes: 10080,
      verifiedDurationMinutes: 10080,
      usedPercent: 5,
      resetsAt: Date.now() + 4 * 86_400_000
    }
  ]
  expect(store.acquireAccountPoolAssignment(args)).toMatchObject({
    accountId: 'b',
    selectionReason: expect.stringContaining('Compared verified 7d usage')
  })
  expect(store.listAccountPoolAssignments()[0].selectionReason).toContain('5%')
  expect(store.listAccountPoolAssignments()[0].selectionReason).toContain('50%')
})
it('adds the decision explanation column when opening an older assignment table', () => {
  const { store } = fixture()
  store.db.exec('ALTER TABLE account_pool_assignments DROP COLUMN selection_reason')
  store.db.pragma('user_version = 43')
  store.migrate()
  expect(store.hasColumn('account_pool_assignments', 'selection_reason')).toBe(true)
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

it('removes only released bindings while preserving stale-owner fences and recency', () => {
  const { store, args } = fixture()
  const first = store.acquireAccountPoolAssignment(args)
  store.bindAccountPoolAssignmentPty({
    ownerKey: first.ownerKey,
    ptyId: 'pty',
    incarnationId: 'old'
  })
  const second = store.acquireAccountPoolAssignment({ ...args, ownerKey: 'active' })
  store.bindAccountPoolAssignmentPty({
    ownerKey: second.ownerKey,
    ptyId: 'pty',
    incarnationId: 'live'
  })

  store.releaseAccountPoolAssignment(first.ownerKey)

  expect(store.db.prepare('SELECT owner_key FROM account_pool_pty_bindings').all()).toEqual([
    { owner_key: second.ownerKey }
  ])
  expect(
    store.db
      .prepare('SELECT sequence FROM account_pool_assignments WHERE owner_key=?')
      .get(first.ownerKey)
  ).toEqual({ sequence: first.sequence })
  expect(() => store.acquireAccountPoolAssignment(args)).toThrow(/new execution generation/)
  expect(store.listAccountPoolAssignments()[0]).toMatchObject({
    ownerKey: second.ownerKey,
    incarnationId: 'live'
  })
})

it('settles all bindings of the exact exited generation and preserves unknown generations', () => {
  const { store, args } = fixture()
  args.policy.members.forEach((member) => {
    member.maxConcurrent = undefined
  })
  for (const ownerKey of ['first', 'second', 'unverifiable']) {
    store.acquireAccountPoolAssignment({ ...args, ownerKey })
    store.bindAccountPoolAssignmentPty({
      ownerKey,
      ptyId: 'pty',
      incarnationId: ownerKey === 'unverifiable' ? 'new' : 'old'
    })
  }
  store.releaseAccountPoolPtyGeneration('pty', undefined)
  expect(store.listAccountPoolAssignments()).toHaveLength(3)
  store.releaseAccountPoolPtyGeneration('pty', 'old')
  expect(store.db.prepare('SELECT owner_key FROM account_pool_pty_bindings').all()).toEqual([
    { owner_key: 'unverifiable' }
  ])
  expect(store.listAccountPoolAssignments()).toHaveLength(1)
})

it('cleans old released bindings in bounded startup batches without pruning assignments', () => {
  const { store } = fixture()
  store.db.exec('DROP TRIGGER remove_released_account_pool_binding')
  const assignment = store.db.prepare(
    "INSERT INTO account_pool_assignments(owner_key,provider,pool_id,policy_revision,account_id,quota_identity,released_at) VALUES (?, 'codex', 'pool', 1, 'a', 'quota', ?)"
  )
  const binding = store.db.prepare(
    "INSERT INTO account_pool_pty_bindings(owner_key,pty_id) VALUES (?, 'pty')"
  )
  for (let index = 0; index < 260; index++) {
    const owner = `old:${index}`
    assignment.run(owner, '2026-11-04')
    binding.run(owner)
  }
  assignment.run('still-active', null)
  binding.run('still-active')

  store.db.exec(ACCOUNT_POOL_ASSIGNMENTS_SQL)
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM account_pool_pty_bindings').get()).toEqual(
    { count: 5 }
  )
  store.db.exec(ACCOUNT_POOL_ASSIGNMENTS_SQL)
  expect(store.db.prepare('SELECT owner_key FROM account_pool_pty_bindings').all()).toEqual([
    { owner_key: 'still-active' }
  ])
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM account_pool_assignments').get()).toEqual({
    count: 261
  })
})
