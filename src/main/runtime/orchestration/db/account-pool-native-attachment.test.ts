import { expect, it } from 'vitest'
import { acquireAccountPoolAssignmentInTransaction } from './account-pool-assignments'
import {
  attachClaudeNativeAccountPoolEpoch,
  beginNativeAccountPoolEpoch
} from './account-pool-native-fences'
import type { NativeAccountPoolScope } from './account-pool-native-fences'
import { nativeAccountPoolFenceFixture } from './account-pool-native-fence-fixture'
function fixture() {
  const f = nativeAccountPoolFenceFixture()
  const epoch = beginNativeAccountPoolEpoch(f.store.db, f.proof, 'claude')
  const args = {
    ...f.args,
    policy: {
      ...f.args.policy,
      provider: 'claude' as const,
      members: f.args.policy.members.map((member) => ({ ...member, maxConcurrent: 2 }))
    }
  }
  const allocate = (scope: NativeAccountPoolScope) => {
    f.store.db.exec('BEGIN IMMEDIATE')
    try {
      const row = acquireAccountPoolAssignmentInTransaction(f.store.db, {
        ...args,
        ownerKey: scope.nextOwnerKey()
      })
      f.store.db.exec('COMMIT')
      return row
    } catch (error) {
      f.store.db.exec('ROLLBACK')
      throw error
    }
  }
  const snapshot = () => ({
    epochs: f.store.db.prepare('SELECT * FROM account_pool_native_epochs ORDER BY provider').all(),
    scopes: f.store.db.prepare('SELECT * FROM account_pool_native_scopes ORDER BY scope_id').all(),
    assignments: f.store.db
      .prepare('SELECT * FROM account_pool_assignments ORDER BY sequence')
      .all()
  })
  return { ...f, epoch, args, allocate, snapshot }
}
it('attaches without changing epoch, generations or current-plus-pending leases, then creates a fresh scope', () => {
  const f = fixture()
  const old = f.epoch.registerScope()
  const first = f.allocate(old)
  const pending = f.allocate(old)
  const before = f.snapshot()
  const attached = attachClaudeNativeAccountPoolEpoch(f.store.db, f.proof)
  expect(f.snapshot()).toEqual(before)
  const fresh = attached.registerScope()
  const ids = f.store.db.prepare('SELECT scope_id FROM account_pool_native_scopes').all()
  expect(ids).toHaveLength(2)
  expect(new Set(ids.map((row) => row.scope_id)).size).toBe(2)
  const freshAssignment = f.allocate(fresh)
  expect(freshAssignment.ownerKey).toMatch(/:1$/)
  fresh.close()
  expect(f.snapshot().epochs).toEqual(before.epochs)
  expect(f.snapshot().scopes).toEqual(before.scopes)
  expect(
    f
      .snapshot()
      .assignments.filter((row) =>
        [first.ownerKey, pending.ownerKey].includes(String(row.owner_key))
      )
  ).toEqual(before.assignments)
  expect(() =>
    f.store.acquireAccountPoolAssignment({
      ...f.args,
      policy: { ...f.args.policy, provider: 'claude' },
      ownerKey: first.ownerKey
    })
  ).toThrow(/stale or revoked/)
  expect(
    f.store.acquireAccountPoolAssignment({
      ...f.args,
      policy: { ...f.args.policy, provider: 'claude' },
      ownerKey: pending.ownerKey
    })
  ).toEqual(pending)
})
it('uses the original host proof for old objects even while their retained DB generations remain valid', () => {
  const f = nativeAccountPoolFenceFixture()
  let host = 1
  const proof = (generation: number) => ({
    assertExclusive() {
      if (host !== generation) {
        throw new Error('stale host proof')
      }
    },
    assertWriterIdle() {}
  })
  const first = beginNativeAccountPoolEpoch(f.store.db, proof(1), 'claude')
  const old = first.registerScope()
  host = 2
  const fresh = attachClaudeNativeAccountPoolEpoch(f.store.db, proof(2)).registerScope()
  const before = f.store.db
    .prepare('SELECT * FROM account_pool_native_scopes ORDER BY scope_id')
    .all()
  f.store.db.exec('BEGIN IMMEDIATE')
  expect(() => old.nextOwnerKey()).toThrow(/stale host proof/)
  f.store.db.exec('ROLLBACK')
  expect(() => old.close()).toThrow(/stale host proof/)
  expect(
    f.store.db.prepare('SELECT * FROM account_pool_native_scopes ORDER BY scope_id').all()
  ).toEqual(before)
  fresh.close()
  expect(
    f.store.db.prepare('SELECT COUNT(*) AS count FROM account_pool_native_scopes').get()
  ).toEqual({ count: 1 })
})
it('preserves the global64 scope cap including the other provider after attachment', () => {
  const f = fixture()
  f.store.db
    .prepare(
      "INSERT INTO account_pool_native_scopes(scope_id,provider,epoch,generation) VALUES('00000000-0000-4000-8000-000000000000','codex',1,0)"
    )
    .run()
  for (let index = 0; index < 63; index++) {
    f.epoch.registerScope()
  }
  const before = f.snapshot()
  const attached = attachClaudeNativeAccountPoolEpoch(f.store.db, f.proof)
  expect(() => attached.registerScope()).toThrow(/capacity/)
  expect(f.snapshot()).toEqual(before)
})
it.each([
  'orphan',
  'future',
  'provider',
  'missing-epoch',
  'legacy',
  'v1',
  'surplus',
  'schema'
] as const)('refuses %s retained state without changing any resource evidence', (kind) => {
  const f = fixture()
  const old = f.epoch.registerScope()
  const assignment = f.allocate(old)
  if (kind === 'orphan') {
    f.store.db.exec("DELETE FROM account_pool_native_scopes WHERE provider='claude'")
  }
  if (kind === 'future') {
    f.store.db
      .prepare('UPDATE account_pool_assignments SET owner_key=? WHERE owner_key=?')
      .run(assignment.ownerKey.replace(/:1$/, ':2'), assignment.ownerKey)
  }
  if (kind === 'provider') {
    f.store.db
      .prepare("UPDATE account_pool_assignments SET provider='codex' WHERE owner_key=?")
      .run(assignment.ownerKey)
  }
  if (kind === 'missing-epoch') {
    f.store.db.exec("DELETE FROM account_pool_native_epochs WHERE provider='claude'")
  }
  if (kind === 'legacy' || kind === 'v1') {
    f.store.db
      .prepare(
        "INSERT INTO account_pool_assignments(owner_key,provider,pool_id,policy_revision,account_id,quota_identity) VALUES(?,'claude','pool',1,'x','x')"
      )
      .run(kind === 'legacy' ? 'native-cli:retained' : 'native-scope-v1:retained')
  }
  if (kind === 'schema') {
    f.store.db.exec('ALTER TABLE account_pool_native_scopes ADD COLUMN unknown_future TEXT')
  }
  if (kind === 'surplus') {
    f.store.db.prepare('UPDATE account_pool_native_scopes SET generation=3').run()
    const insert = f.store.db
      .prepare(`INSERT INTO account_pool_assignments(owner_key,provider,pool_id,policy_revision,account_id,quota_identity)
        VALUES(?,'claude','pool',1,'x','x')`)
    insert.run(assignment.ownerKey.replace(/:1$/, ':2'))
    insert.run(assignment.ownerKey.replace(/:1$/, ':3'))
  }
  const before = f.snapshot()
  expect(() => attachClaudeNativeAccountPoolEpoch(f.store.db, f.proof)).toThrow(/recovery/)
  expect(f.snapshot()).toEqual(before)
  expect(f.store.db.isTransaction).toBe(false)
})
it('rolls back an attachment whose source writer proof becomes unavailable before commit', () => {
  const f = fixture()
  f.epoch.registerScope()
  const before = f.snapshot()
  let checks = 0
  expect(() =>
    attachClaudeNativeAccountPoolEpoch(f.store.db, {
      assertExclusive() {},
      assertWriterIdle() {
        if (++checks === 2) {
          throw new Error('lost idle proof')
        }
      }
    })
  ).toThrow(/lost idle proof/)
  expect(f.snapshot()).toEqual(before)
  expect(f.store.db.isTransaction).toBe(false)
})
