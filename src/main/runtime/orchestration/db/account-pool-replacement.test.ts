import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import type { AcquireAccountPoolAssignment } from './account-pool-assignments'

let database: OrchestrationDb | undefined
afterEach(() => database?.close())
function fixture(capacity = 1) {
  const store = new OrchestrationDb(':memory:')
  database = store
  const initial: AcquireAccountPoolAssignment = {
    ownerKey: 'native:old',
    policy: {
      id: 'pool',
      provider: 'claude',
      revision: 1,
      strategy: 'sequential',
      applyToNewWork: true,
      rotation: 'after-turn',
      unknownQuota: 'allow',
      allowReserve: false,
      members: [
        {
          accountId: 'a',
          priority: 1,
          weight: 1,
          maxConcurrent: capacity,
          state: 'enabled',
          role: 'primary'
        }
      ]
    },
    candidates: [
      {
        accountId: 'a',
        quotaIdentity: 'shared-quota',
        auth: 'ready',
        quota: 'unknown',
        usedPercent: null
      }
    ]
  }
  store.acquireAccountPoolAssignment(initial)
  const replacement = { ...initial, ownerKey: 'native:new', replacesOwnerKey: initial.ownerKey }
  return { store, initial, replacement }
}

it('retains the old lease while reelecting its own capacity-one account', () => {
  const { store, initial, replacement } = fixture()
  expect(store.acquireAccountPoolAssignment(replacement).accountId).toBe('a')
  expect(store.listAccountPoolAssignments().map((row) => row.ownerKey)).toEqual([
    initial.ownerKey,
    replacement.ownerKey
  ])
  expect(() =>
    store.acquireAccountPoolAssignment({ ...initial, ownerKey: 'native:other' })
  ).toThrow('No eligible account')
  expect(store.acquireAccountPoolAssignment(replacement).ownerKey).toBe(replacement.ownerKey)
})

it('permits only one pending replacement for an old owner even with spare capacity', () => {
  const { store, replacement } = fixture(2)
  store.acquireAccountPoolAssignment(replacement)
  expect(() =>
    store.acquireAccountPoolAssignment({ ...replacement, ownerKey: 'native:concurrent' })
  ).toThrow('cannot be replaced')
  expect(store.listAccountPoolAssignments()).toHaveLength(2)
})

it('releases a failed publication reservation without releasing the previous owner', () => {
  const { store, initial, replacement } = fixture()
  store.acquireAccountPoolAssignment(replacement)
  store.releaseAccountPoolAssignment(replacement.ownerKey)
  expect(store.listAccountPoolAssignments().map((row) => row.ownerKey)).toEqual([initial.ownerKey])
  expect(
    store.acquireAccountPoolAssignment({ ...replacement, ownerKey: 'native:retry' }).accountId
  ).toBe('a')
})

it('removes the claim after publication and supports the next handoff', () => {
  const { store, initial, replacement } = fixture()
  store.acquireAccountPoolAssignment(replacement)
  store.releaseAccountPoolAssignment(initial.ownerKey)
  expect(store.db.prepare('SELECT * FROM account_pool_replacement_claims').all()).toEqual([])
  expect(() =>
    store.acquireAccountPoolAssignment({ ...replacement, ownerKey: 'native:stale' })
  ).toThrow('cannot be replaced')
  expect(
    store.acquireAccountPoolAssignment({
      ...replacement,
      ownerKey: 'native:next',
      replacesOwnerKey: replacement.ownerKey
    }).accountId
  ).toBe('a')
})

it.each(['unknown', 'different-pool', 'different-provider'])(
  'rejects %s replacement ownership without changing allocations',
  (scenario) => {
    const { store, replacement } = fixture()
    if (scenario === 'unknown') {
      replacement.replacesOwnerKey = 'native:missing'
    }
    if (scenario === 'different-pool') {
      replacement.policy = { ...replacement.policy, id: 'other' }
    }
    if (scenario === 'different-provider') {
      replacement.policy = { ...replacement.policy, provider: 'codex' }
    }
    expect(() => store.acquireAccountPoolAssignment(replacement)).toThrow('cannot be replaced')
    expect(store.listAccountPoolAssignments()).toHaveLength(1)
    expect(store.db.prepare('SELECT * FROM account_pool_replacement_claims').all()).toEqual([])
  }
)
