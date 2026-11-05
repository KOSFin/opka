import { expect, it } from 'vitest'
import { acquireAccountPoolAssignmentInTransaction } from './account-pool-assignments'
import {
  beginNativeAccountPoolEpoch,
  readNativeAccountPoolPartition,
  compactReleasedNativeAccountPoolRows
} from './account-pool-native-fences'
import { nativeAccountPoolFenceFixture as fixture } from './account-pool-native-fence-fixture'
it('compacts native generations while preserving exact balanced recency and legacy replay fences', () => {
  const { store, epoch, allocate, args } = fixture()
  const legacy = store.acquireAccountPoolAssignment({ ...args, ownerKey: 'worker:old' })
  store.releaseAccountPoolAssignment(legacy.ownerKey)
  const scope = epoch.registerScope()
  let firstKey = ''
  const maxima = new Map([[legacy.quotaIdentity, legacy.sequence]])
  for (let index = 0; index < 1000; index++) {
    const assignment = allocate(scope)
    if (index === 0) {
      firstKey = assignment.ownerKey
    }
    maxima.set(assignment.quotaIdentity, assignment.sequence)
    store.releaseAccountPoolAssignment(assignment.ownerKey)
  }
  scope.close()
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM account_pool_assignments').get()).toEqual({
    count: 3
  })
  expect(
    store.db.prepare('SELECT COUNT(*) AS count FROM account_pool_native_scopes').get()
  ).toEqual({ count: 0 })
  expect(() => store.acquireAccountPoolAssignment({ ...args, ownerKey: firstKey })).toThrow(
    /stale or revoked/
  )
  expect(() => store.acquireAccountPoolAssignment({ ...args, ownerKey: legacy.ownerKey })).toThrow(
    /already bound/
  )
  expect(
    store.db
      .prepare(
        'SELECT quota_identity,MAX(sequence) AS sequence FROM account_pool_assignments GROUP BY quota_identity ORDER BY quota_identity'
      )
      .all()
  ).toEqual(
    [...maxima]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([quota_identity, sequence]) => ({ quota_identity, sequence }))
  )
})
it('rolls generation back with a failed allocation and rejects old generations after success', () => {
  const { store, epoch, allocate, args } = fixture()
  const scope = epoch.registerScope()
  const first = allocate(scope)
  expect(store.acquireAccountPoolAssignment({ ...args, ownerKey: first.ownerKey })).toEqual(first)
  store.releaseAccountPoolAssignment(first.ownerKey)
  store.db.exec('BEGIN IMMEDIATE')
  const failedKey = scope.nextOwnerKey()
  expect(() =>
    acquireAccountPoolAssignmentInTransaction(store.db, {
      ...args,
      candidates: [],
      ownerKey: failedKey
    })
  ).toThrow()
  store.db.exec('ROLLBACK')
  expect(store.db.prepare('SELECT generation FROM account_pool_native_scopes').get()).toEqual({
    generation: 1
  })
  const next = allocate(scope)
  expect(next.ownerKey).toBe(failedKey)
  expect(() => store.acquireAccountPoolAssignment({ ...args, ownerKey: first.ownerKey })).toThrow(
    /stale or revoked/
  )
})
it('revocation rejects reacquire and stale epoch handles cannot touch recovered scope', () => {
  const { store, epoch, proof, args, allocate } = fixture()
  const old = epoch.registerScope()
  const first = allocate(old)
  const recovered = beginNativeAccountPoolEpoch(store.db, proof)
  expect(store.listAccountPoolAssignments()).toHaveLength(0)
  expect(() => allocate(old)).toThrow(/epoch is stale/)
  expect(() => store.acquireAccountPoolAssignment({ ...args, ownerKey: first.ownerKey })).toThrow(
    /stale or revoked/
  )
  const current = recovered.registerScope()
  allocate(current)
  expect(() => old.close()).toThrow(/epoch is stale/)
  expect(store.listAccountPoolAssignments()).toHaveLength(1)
  current.close()
  expect(() => allocate(current)).toThrow(/revoked/)
})
it('unverifiable writer and stale profile cannot advance epoch or free a lease', () => {
  const { store, epoch, proof, allocate, setIdle, setExclusive } = fixture()
  const scope = epoch.registerScope()
  allocate(scope)
  setIdle(false)
  expect(() => beginNativeAccountPoolEpoch(store.db, proof)).toThrow(/unverifiable writer/)
  expect(store.listAccountPoolAssignments()).toHaveLength(1)
  setIdle(true)
  setExclusive(false)
  expect(() => scope.close()).toThrow(/stale profile/)
  expect(store.listAccountPoolAssignments()).toHaveLength(1)
})
it('registration is explicit, bounded at 64, and released quota maxima survive cleanup', () => {
  const { store, epoch, args } = fixture()
  const scopes = Array.from({ length: 64 }, () => epoch.registerScope())
  expect(() => epoch.registerScope()).toThrow(/capacity/)
  expect(() =>
    store.acquireAccountPoolAssignment({
      ...args,
      ownerKey: 'native-scope-v2:codex:1:00000000-0000-4000-8000-000000000000:1'
    })
  ).toThrow(/stale or revoked/)
  scopes[0].close()
  epoch.registerScope()
  compactReleasedNativeAccountPoolRows(store.db)
  expect(
    store.db.prepare('SELECT COUNT(*) AS count FROM account_pool_native_scopes').get()
  ).toEqual({ count: 64 })
})

it('recovery rolls back on a proof lost before commit and refuses orphaned active scope records', () => {
  const { store, epoch, allocate } = fixture()
  const scope = epoch.registerScope()
  allocate(scope)
  let reads = 0
  expect(() =>
    beginNativeAccountPoolEpoch(store.db, {
      assertExclusive() {},
      assertWriterIdle() {
        if (++reads === 2) {
          throw new Error('lost recovery proof')
        }
      }
    })
  ).toThrow(/lost recovery proof/)
  expect(store.db.prepare('SELECT epoch FROM account_pool_native_epochs').get()).toEqual({
    epoch: 1
  })
  expect(store.listAccountPoolAssignments()).toHaveLength(1)
  store.db.exec('DELETE FROM account_pool_native_scopes')
  expect(() =>
    beginNativeAccountPoolEpoch(store.db, { assertExclusive() {}, assertWriterIdle() {} })
  ).toThrow(/stale or revoked/)
  expect(store.listAccountPoolAssignments()).toHaveLength(1)
})

it('cleanup removes at most 256 indexed released rows and keeps the exact quota maximum', () => {
  const { store, epoch } = fixture()
  const scope = epoch.registerScope()
  store.db.exec('BEGIN IMMEDIATE')
  const insert = store.db.prepare(
    "INSERT INTO account_pool_assignments(owner_key,provider,pool_id,policy_revision,account_id,quota_identity,released_at) VALUES(?,'codex','pool',1,'a','a','closed')"
  )
  for (let index = 0; index < 600; index++) {
    insert.run(scope.nextOwnerKey())
  }
  store.db.exec('COMMIT')
  const count = () =>
    store.db.prepare('SELECT COUNT(*) AS count FROM account_pool_assignments').get()
  compactReleasedNativeAccountPoolRows(store.db)
  expect(count()).toEqual({ count: 344 })
  compactReleasedNativeAccountPoolRows(store.db)
  expect(count()).toEqual({ count: 88 })
  compactReleasedNativeAccountPoolRows(store.db)
  expect(count()).toEqual({ count: 1 })
  expect(store.db.prepare('SELECT sequence FROM account_pool_assignments').get()).toEqual({
    sequence: 600
  })
})
it('partitions recovery by provider and rejects a cross-provider tagged acquire', () => {
  const { store, epoch, proof, args, allocate } = fixture()
  const codex = epoch.registerScope()
  const codexAssignment = allocate(codex)
  const claudeEpoch = beginNativeAccountPoolEpoch(store.db, proof, 'claude')
  const claude = claudeEpoch.registerScope()
  store.db.exec('BEGIN IMMEDIATE')
  const key = claude.nextOwnerKey()
  expect(() =>
    acquireAccountPoolAssignmentInTransaction(store.db, { ...args, ownerKey: key })
  ).toThrow(/provider mismatch/)
  const claudeAssignment = acquireAccountPoolAssignmentInTransaction(store.db, {
    ...args,
    policy: { ...args.policy, provider: 'claude' },
    ownerKey: key
  })
  store.db.exec('COMMIT')
  expect(() => beginNativeAccountPoolEpoch(store.db, proof, 'claude')).toThrow(
    /prior-process recovery/
  )
  expect(readNativeAccountPoolPartition(store.db, 'claude')).toMatchObject({
    epoch: 1,
    scopes: 1,
    activeAssignments: 1
  })
  claude.close()
  beginNativeAccountPoolEpoch(store.db, proof, 'claude')
  expect(store.listAccountPoolAssignments().map((row) => row.ownerKey)).toEqual([
    codexAssignment.ownerKey
  ])
  expect(
    store.acquireAccountPoolAssignment({ ...args, ownerKey: codexAssignment.ownerKey })
  ).toEqual(codexAssignment)
  expect(() =>
    store.acquireAccountPoolAssignment({
      ...args,
      policy: { ...args.policy, provider: 'claude' },
      ownerKey: claudeAssignment.ownerKey
    })
  ).toThrow(/stale or revoked/)
  expect(
    store.db.prepare('SELECT COUNT(*) AS count FROM account_pool_native_epochs').get()
  ).toEqual({ count: 2 })
})
it('preserves and explicitly refuses old unshipped native namespaces or scope-table shapes', () => {
  const { store, proof, args } = fixture()
  const old = 'native-scope-v1:1:00000000-0000-4000-8000-000000000000:1'
  store.db
    .prepare(
      "INSERT INTO account_pool_assignments(owner_key,provider,pool_id,policy_revision,account_id,quota_identity,released_at) VALUES(?,'codex','pool',1,'a','a','closed')"
    )
    .run(old)
  expect(() => store.acquireAccountPoolAssignment({ ...args, ownerKey: old })).toThrow(
    /explicit recovery/
  )
  expect(() => beginNativeAccountPoolEpoch(store.db, proof)).toThrow(/explicit recovery/)
  expect(store.db.prepare('SELECT owner_key FROM account_pool_assignments').get()).toEqual({
    owner_key: old
  })
  store.db.exec(
    'ALTER TABLE account_pool_native_scopes RENAME TO owned_test_scope_backup; CREATE TABLE account_pool_native_scopes(scope_id TEXT PRIMARY KEY,epoch INTEGER,generation INTEGER)'
  )
  expect(() => beginNativeAccountPoolEpoch(store.db, proof, 'claude')).toThrow(/explicit recovery/)
})

it('refuses owner-key allocation outside a transaction without advancing its durable generation', () => {
  const { store, epoch, allocate } = fixture()
  const scope = epoch.registerScope()
  expect(() => scope.nextOwnerKey()).toThrow(/requires an active transaction/)
  expect(store.db.prepare('SELECT generation FROM account_pool_native_scopes').get()).toEqual({
    generation: 0
  })
  expect(store.listAccountPoolAssignments()).toHaveLength(0)
  expect(allocate(scope).ownerKey).toMatch(/:1$/)
})

it('allows current plus pending but refuses a third active assignment before advancing the scope', () => {
  const { store, epoch, args } = fixture()
  const scope = epoch.registerScope()
  const allocate = () => {
    store.db.exec('BEGIN IMMEDIATE')
    try {
      const row = acquireAccountPoolAssignmentInTransaction(store.db, {
        ...args,
        policy: {
          ...args.policy,
          members: args.policy.members.map((member) => ({ ...member, maxConcurrent: 3 }))
        },
        ownerKey: scope.nextOwnerKey()
      })
      store.db.exec('COMMIT')
      return row
    } catch (error) {
      store.db.exec('ROLLBACK')
      throw error
    }
  }
  const current = allocate()
  allocate()
  const before = store.db.prepare('SELECT * FROM account_pool_native_scopes').all()
  expect(store.listAccountPoolAssignments()).toHaveLength(2)
  expect(() => allocate()).toThrow(/retained-work capacity/)
  expect(store.db.prepare('SELECT * FROM account_pool_native_scopes').all()).toEqual(before)
  expect(store.listAccountPoolAssignments()).toHaveLength(2)
  store.releaseAccountPoolAssignment(current.ownerKey)
  expect(allocate().ownerKey).toMatch(/:3$/)
  expect(store.listAccountPoolAssignments()).toHaveLength(2)
})
