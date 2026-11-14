import { expect, it } from 'vitest'
import { beginNativeAccountPoolEpoch } from './account-pool-native-fences'
import { nativeAccountPoolFenceFixture } from './account-pool-native-fence-fixture'

it('recovers a hundred active native assignments only after exclusive idle proof', () => {
  const f = nativeAccountPoolFenceFixture()
  for (const member of f.args.policy.members) {
    member.maxConcurrent = undefined
  }
  const scopes = Array.from({ length: 100 }, () => f.epoch.registerScope())
  const assignments = scopes.map((scope) => f.allocate(scope))
  expect(f.store.listAccountPoolAssignments()).toHaveLength(100)
  f.setIdle(false)
  expect(() => beginNativeAccountPoolEpoch(f.store.db, f.proof)).toThrow('unverifiable writer')
  expect(f.store.listAccountPoolAssignments()).toHaveLength(100)
  f.setIdle(true)
  const recovered = beginNativeAccountPoolEpoch(f.store.db, f.proof)
  expect(f.store.listAccountPoolAssignments()).toHaveLength(0)
  expect(
    f.store.db.prepare('SELECT COUNT(*) AS count FROM account_pool_native_scopes').get()
  ).toEqual({ count: 0 })
  expect(() =>
    f.store.acquireAccountPoolAssignment({ ...f.args, ownerKey: assignments[0].ownerKey })
  ).toThrow(/stale or revoked/)
  const fresh = recovered.registerScope()
  expect(f.allocate(fresh).ownerKey).not.toBe(assignments[0].ownerKey)
  fresh.close()
  expect(f.store.listAccountPoolAssignments()).toHaveLength(0)
})
