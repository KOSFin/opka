// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { usageAccountRoster } from './usage-account-roster'

function usage(percent: number): ProviderRateLimits {
  return {
    provider: 'codex',
    status: 'ok',
    error: null,
    updatedAt: 1,
    weekly: null,
    session: { usedPercent: percent, windowMinutes: 300, resetsAt: null, resetDescription: null }
  }
}
function snapshot(): ProviderAccountsSnapshot {
  return {
    claude: { accounts: [], activeAccountId: null },
    codex: {
      accounts: [
        {
          id: 'one',
          email: 'one@example.test',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        { id: 'two', email: 'two@example.test', createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 }
      ],
      activeAccountId: 'one'
    },
    rateLimits: null
  }
}
it('attributes active and inactive limits to exact accounts and keeps missing limits unknown', () => {
  const rates = createEmptyRateLimitState({
    codex: { ...usage(70), usageMetadata: { authProvenance: 'profile:one' } },
    inactiveCodexAccounts: [
      { accountId: 'two', rateLimits: usage(22), updatedAt: 1, isFetching: false }
    ]
  })
  const rows = usageAccountRoster('codex', snapshot(), rates)
  expect(rows?.find((row) => row.id === 'one')?.limits?.session?.usedPercent).toBe(70)
  expect(rows?.find((row) => row.id === 'two')?.limits?.session?.usedPercent).toBe(22)
  expect(rows?.find((row) => row.id === null)).toBeUndefined()
})
it('omits an unverified system login while a saved profile is active', () => {
  const rows = usageAccountRoster('codex', snapshot(), createEmptyRateLimitState())
  expect(rows?.map((row) => row.id)).toEqual(['one', 'two'])
})
it('does not treat a failed provider as an authoritative empty account list', () => {
  const source = snapshot()
  source.failedProviders = ['codex']
  expect(usageAccountRoster('codex', source, createEmptyRateLimitState())).toBeNull()
})
it('does not attach a saved account limit to an inactive system login', () => {
  const source = snapshot()
  source.codex.systemDefault = {
    hasAuth: true,
    authKind: 'oauth',
    email: 'system@example.test',
    providerAccountId: 'system',
    workspaceLabel: null
  }
  const rows = usageAccountRoster('codex', source, createEmptyRateLimitState({ codex: usage(80) }))
  expect(rows?.find((row) => row.id === null)?.label).toContain('system@example.test')
  expect(rows?.find((row) => row.id === null)?.limits).toBeNull()
})

it('keeps WSL account rows separate from native host accounts', () => {
  const source = snapshot()
  source.codex.accounts[1] = {
    ...source.codex.accounts[1],
    managedHomeRuntime: 'wsl',
    wslDistro: 'Ubuntu'
  }
  source.codex.activeAccountIdsByRuntime = { host: 'one', wsl: { Ubuntu: 'two' } }
  const rows = usageAccountRoster(
    'codex',
    source,
    createEmptyRateLimitState({ codexTarget: { runtime: 'wsl', wslDistro: null } })
  )
  expect(rows?.some((row) => row.id === 'one')).toBe(false)
  expect(rows?.find((row) => row.id === 'two')?.active).toBe(true)
})

it('keeps a newly selected account unknown when active quota still proves the previous profile', () => {
  const source = snapshot()
  source.codex.activeAccountId = 'two'
  const rates = createEmptyRateLimitState({
    codex: { ...usage(70), usageMetadata: { authProvenance: 'profile:one' } }
  })
  expect(
    usageAccountRoster('codex', source, rates)?.find((row) => row.id === 'two')?.limits
  ).toBeNull()
})

it('keeps CLI source and saved profiles distinct and explains same-email organization/workspace context', () => {
  const source = snapshot()
  source.claude = {
    accounts: ['Organization A', 'Organization B'].map((organizationName, index) => ({
      id: `org-${index}`,
      email: 'same@example.test',
      organizationName,
      authMethod: 'subscription-oauth' as const,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    })),
    activeAccountId: 'org-0',
    systemDefaultEmail: 'same@example.test'
  }
  const rows = usageAccountRoster('claude', source, createEmptyRateLimitState())
  expect(rows?.find((row) => row.id === null)?.label).toBe(
    'CLI login on this host · same@example.test'
  )
  expect(rows?.find((row) => row.id === 'org-0')).toMatchObject({
    label: 'same@example.test',
    detail: 'Organization A'
  })
  expect(rows?.find((row) => row.id === 'org-1')).toMatchObject({
    label: 'same@example.test',
    detail: 'Organization B'
  })
  source.codex.accounts[0].workspaceLabel = 'Personal'
  expect(
    usageAccountRoster('codex', source, createEmptyRateLimitState())?.find(
      (row) => row.id === 'one'
    )?.detail
  ).toBe('Personal')
})

it.each(['profile:one', 'profile:two:wsl:Ubuntu'])(
  'rejects an exact-ID inactive sample with contradictory proof %s',
  (authProvenance) => {
    const rates = createEmptyRateLimitState({
      inactiveCodexAccounts: [
        {
          accountId: 'two',
          rateLimits: { ...usage(22), usageMetadata: { authProvenance } },
          updatedAt: 1,
          isFetching: false
        }
      ]
    })
    expect(
      usageAccountRoster('codex', snapshot(), rates)?.find((row) => row.id === 'two')?.limits
    ).toBeNull()
  }
)
