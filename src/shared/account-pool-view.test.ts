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

it('drops removed registrations from drafts without changing saved policy or surviving member settings', () => {
  const original = setPoolMembership(
    setPoolMembership(
      accountPoolDrafts({
        capability: 'orchestration.account-pools.v1',
        policies: [],
        accounts: {
          claude: { accounts: [], activeAccountId: null },
          codex: { accounts: [], activeAccountId: null }
        },
        candidates: [],
        assignments: []
      })[1],
      'removed',
      'draining'
    ),
    'retained',
    'enabled'
  )
  original.revision = 22
  original.members[1].priority = 7
  const drafts = accountPoolDrafts({
    capability: 'orchestration.account-pools.v1',
    policies: [original],
    accounts: {
      claude: { accounts: [], activeAccountId: null },
      codex: {
        accounts: [{ id: 'retained', email: 'synthetic@example.test' }],
        activeAccountId: 'retained'
      }
    },
    candidates: [],
    assignments: []
  })
  expect(drafts[1]).toMatchObject({
    revision: 22,
    members: [{ accountId: 'retained', priority: 7 }]
  })
  expect(drafts[1].members).toHaveLength(1)
  expect(original.members).toHaveLength(2)
})
