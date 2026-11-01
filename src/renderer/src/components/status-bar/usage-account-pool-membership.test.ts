import { expect, it } from 'vitest'
import { AccountPoolViewSchema } from '../../../../shared/account-pool-view'
import { usageAccountPoolMembership } from './usage-account-pool-membership'

const view = AccountPoolViewSchema.parse({
  capability: 'orchestration.account-pools.v1',
  policies: [
    {
      id: 'codex',
      provider: 'codex',
      revision: 1,
      strategy: 'sequential',
      applyToNewWork: true,
      unknownQuota: 'exclude',
      allowReserve: false,
      members: [{ accountId: 'a', state: 'enabled', role: 'reserve', priority: 2, weight: 3 }]
    }
  ],
  accounts: {
    claude: { accounts: [], activeAccountId: null },
    codex: {
      accounts: [
        { id: 'a', email: 'a@example.test' },
        { id: 'b', email: 'b@example.test' }
      ],
      activeAccountId: 'b'
    }
  },
  candidates: [],
  assignments: [{ ownerKey: 'session', provider: 'codex', accountId: 'a', poolId: 'codex' }]
})
it('separates configured membership and assignments from the selected default', () => {
  expect(usageAccountPoolMembership(view, 'codex', 'a')).toMatchObject({
    mode: 'sequential',
    member: { priority: 2, role: 'reserve' },
    assignments: 1
  })
  expect(usageAccountPoolMembership(view, 'codex', 'b')).toMatchObject({
    member: null,
    assignments: 0
  })
})
it('does not infer exclusion for an unknown identity or another provider', () => {
  expect(usageAccountPoolMembership(view, 'codex', 'missing')).toBeNull()
  expect(usageAccountPoolMembership(view, 'claude', 'a')).toBeNull()
})
it('shows configured membership while new-work opt-in is off', () => {
  const disabled = {
    ...view,
    policies: view.policies.map((entry) => ({ ...entry, applyToNewWork: false }))
  }
  expect(usageAccountPoolMembership(disabled, 'codex', 'a')).toMatchObject({
    mode: 'off',
    member: { priority: 2 }
  })
})
