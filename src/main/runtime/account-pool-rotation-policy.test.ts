import { afterEach, expect, it } from 'vitest'
import type { AccountPoolCandidate, AccountPoolPolicy } from '../../shared/account-pool-policy'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import { selectAccountPoolRotationMember } from './account-pool-rotation-policy'
let db: OrchestrationDb | undefined
afterEach(() => db?.close())
function fixture() {
  db = new OrchestrationDb(':memory:')
  const policy: AccountPoolPolicy = {
    id: 'pool',
    provider: 'codex',
    revision: 1,
    strategy: 'balanced',
    rotation: 'after-turn',
    applyToNewWork: true,
    unknownQuota: 'allow',
    allowReserve: true,
    members: ['a', 'b'].map((accountId) => ({
      accountId,
      priority: 1,
      weight: 1,
      state: 'enabled',
      role: 'primary'
    }))
  }
  const candidates: AccountPoolCandidate[] = ['a', 'b'].map((accountId) => ({
    accountId,
    quotaIdentity: accountId,
    auth: 'ready',
    quota: 'unknown',
    usedPercent: null
  }))
  return { database: db.db, policy, candidates }
}
it('rotates within the same healthy priority tier', () => {
  const f = fixture()
  expect(selectAccountPoolRotationMember(f.database, f, 'a').id).toBe('b')
})
it('does not demote a healthy current account to a lower priority', () => {
  const f = fixture()
  f.policy.members[1].priority = 2
  expect(selectAccountPoolRotationMember(f.database, f, 'a').id).toBe('a')
})
it('does not consume reserve while a primary remains healthy', () => {
  const f = fixture()
  f.policy.members[1].role = 'reserve'
  expect(selectAccountPoolRotationMember(f.database, f, 'a').id).toBe('a')
})
it('uses lower priority or reserve after exhaustion', () => {
  const f = fixture()
  f.candidates[0].quota = 'exhausted'
  f.policy.members[1].role = 'reserve'
  f.policy.members[1].priority = 9
  expect(selectAccountPoolRotationMember(f.database, f, 'a').id).toBe('b')
})
it('keeps the sole healthy account instead of refusing continuation', () => {
  const f = fixture()
  f.policy.members.splice(1)
  expect(selectAccountPoolRotationMember(f.database, f, 'a').id).toBe('a')
})
it('does not manufacture capacity for a saturated alternative', () => {
  const f = fixture()
  f.policy.members[1].maxConcurrent = 1
  db!.acquireAccountPoolAssignment({
    ...f,
    ownerKey: 'other',
    policy: { ...f.policy, members: [f.policy.members[1]] }
  })
  expect(selectAccountPoolRotationMember(f.database, f, 'a').id).toBe('a')
})
it('allows another tier when the current member is draining', () => {
  const f = fixture()
  f.policy.members[0].state = 'draining'
  f.policy.members[1].priority = 2
  expect(selectAccountPoolRotationMember(f.database, f, 'a').id).toBe('b')
})
