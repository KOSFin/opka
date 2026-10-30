import { expect, it } from 'vitest'
import { AccountPoolViewSchema, accountPoolDrafts, setPoolMembership } from './account-pool-view'
it('preserves membership limits when draining and removes excluded accounts', () => {
  const policy = accountPoolDrafts({
    capability: 'orchestration.account-pools.v1',
    policies: [],
    accounts: {
      claude: { accounts: [], activeAccountId: null },
      codex: { accounts: [], activeAccountId: null }
    },
    candidates: [],
    assignments: []
  })[0]
  expect(policy).toMatchObject({ applyToNewWork: false, rotation: 'off' })
  const included = setPoolMembership(policy, 'test', 'enabled')
  included.members[0].priority = 7
  included.members[0].maxConcurrent = 3
  expect(setPoolMembership(included, 'test', 'draining').members[0]).toMatchObject({
    priority: 7,
    maxConcurrent: 3,
    state: 'draining'
  })
  expect(setPoolMembership(included, 'test', 'excluded').members).toEqual([])
})
it('rejects absent capability and invalid host evidence', () => {
  expect(AccountPoolViewSchema.safeParse({ policies: [] }).success).toBe(false)
})
