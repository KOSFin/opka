import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { AccountPoolViewSchema } from '../../../../shared/account-pool-view'
import { UsageAccountPoolLabel } from './UsageAccountPoolLabel'

it('shows the actual host decision only for a verified equalize assignment', () => {
  const view = AccountPoolViewSchema.parse({
    capability: 'orchestration.account-pools.v1',
    policies: [
      {
        id: 'pool',
        provider: 'codex',
        revision: 1,
        strategy: 'quota-equalize',
        applyToNewWork: true,
        unknownQuota: 'exclude',
        allowReserve: false,
        members: [{ accountId: 'a', state: 'enabled', role: 'primary', priority: 1, weight: 1 }]
      }
    ],
    accounts: {
      claude: { accounts: [], activeAccountId: null },
      codex: { accounts: [{ id: 'a', email: 'a@example.test' }], activeAccountId: 'a' }
    },
    candidates: [],
    assignments: [
      {
        ownerKey: 'older',
        provider: 'codex',
        accountId: 'a',
        poolId: 'pool',
        selectionReason: 'Previous decision.'
      },
      {
        ownerKey: 'synthetic',
        provider: 'codex',
        accountId: 'a',
        poolId: 'pool',
        selectionReason: 'Compared verified 7d usage; selected lower observed usage (5%).'
      }
    ]
  })
  const label = (verified: boolean) =>
    renderToStaticMarkup(
      <UsageAccountPoolLabel view={view} verified={verified} provider="codex" accountId="a" />
    )
  expect(label(true)).toContain('selected lower observed usage (5%)')
  expect(label(true)).not.toContain('Previous decision.')
  expect(label(false)).not.toContain('selected lower observed usage (5%)')
  view.assignments.push({
    ownerKey: 'newer',
    provider: 'codex',
    accountId: 'a',
    poolId: 'pool',
    selectionReason: null
  })
  expect(label(true)).not.toContain('selected lower observed usage (5%)')
})
