// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import type { StatusBarAccountPin } from '../../../../shared/status-bar-account-pins'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import { projectUsagePinnedAccounts } from './usage-pinned-account-projection'
const pin: StatusBarAccountPin = {
  owner: 'local',
  provider: 'codex',
  runtimeKey: 'host',
  accountId: 'one',
  label: 'One'
}
const source: ProviderAccountsSnapshot = {
  claude: { accounts: [], activeAccountId: null },
  codex: {
    accounts: [
      { id: 'one', email: 'one@example.test', createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 }
    ],
    activeAccountId: 'one'
  },
  rateLimits: null
}
const limits = createEmptyRateLimitState({
  codex: {
    provider: 'codex',
    status: 'ok',
    error: null,
    updatedAt: 1,
    session: { usedPercent: 27, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null
  }
})
it('scopes pins to owner and runtime, never borrowing another runtime quota', () => {
  expect(
    projectUsagePinnedAccounts([pin], 'environment:other', source, limits, true).visible
  ).toEqual([])
  const result = projectUsagePinnedAccounts(
    [pin, { ...pin, runtimeKey: 'wsl:ubuntu' }],
    'local',
    source,
    limits,
    true
  )
  expect(result.visible[0].limits).toBeNull()
  expect(result.visible[1]).toMatchObject({ limits: null, available: false })
})
it('keeps unavailable, failed and unverified pins unknown instead of replacing identity', () => {
  expect(
    projectUsagePinnedAccounts([{ ...pin, accountId: 'gone' }], 'local', source, limits, true)
      .visible[0]
  ).toMatchObject({ label: 'One', available: false, limits: null })
  expect(
    projectUsagePinnedAccounts(
      [pin],
      'local',
      { ...source, failedProviders: ['codex'] },
      limits,
      true
    ).visible[0].limits
  ).toBeNull()
  expect(
    projectUsagePinnedAccounts([pin], 'local', source, limits, false).visible[0].limits
  ).toBeNull()
})
it('caps visible chips at three with explicit overflow', () => {
  const pins = Array.from({ length: 8 }, (_, index) => ({ ...pin, accountId: String(index) }))
  const result = projectUsagePinnedAccounts(pins, 'local', source, limits, true)
  expect(result.visible).toHaveLength(3)
  expect(result.overflow).toBe(5)
})

it('never attributes untagged local active quota after selection changes, but keeps exact-ID quota', () => {
  expect(
    projectUsagePinnedAccounts([pin], 'local', source, limits, true).visible[0].limits
  ).toBeNull()
  const exact = createEmptyRateLimitState({
    ...limits,
    inactiveCodexAccounts: [
      { accountId: 'one', rateLimits: limits.codex, updatedAt: 1, isFetching: false }
    ]
  })
  expect(projectUsagePinnedAccounts([pin], 'local', source, exact, true).visible[0].limits).toEqual(
    limits.codex
  )
  const system = { ...pin, accountId: null }
  const cliSource = { ...source, codex: { ...source.codex, activeAccountId: null } }
  expect(
    projectUsagePinnedAccounts([system], 'local', cliSource, exact, true).visible[0].limits
  ).toBeNull()
})
it('requires exact provenance even inside a verified remote-owner snapshot', () => {
  const remote = { ...pin, owner: 'environment:remote' }
  expect(
    projectUsagePinnedAccounts([remote], remote.owner, source, limits, true).visible[0].limits
  ).toBeNull()
  const tagged = createEmptyRateLimitState({
    codex: limits.codex
      ? { ...limits.codex, usageMetadata: { authProvenance: 'profile:one' } }
      : null
  })
  expect(
    projectUsagePinnedAccounts([remote], remote.owner, source, tagged, true).visible[0].limits
  ).toEqual(tagged.codex)
})

it('uses existing Claude provenance to prove local active profile and dynamic CLI-source quota', () => {
  const claudeSource: ProviderAccountsSnapshot = {
    ...source,
    claude: {
      accounts: [
        {
          id: 'one',
          email: 'one@example.test',
          authMethod: 'subscription-oauth',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeAccountId: 'one'
    }
  }
  const claudePin: StatusBarAccountPin = { ...pin, provider: 'claude' }
  const quota = {
    ...limits.codex!,
    provider: 'claude' as const,
    usageMetadata: { authProvenance: 'profile:one' }
  }
  const rates = createEmptyRateLimitState({ claude: quota })
  expect(
    projectUsagePinnedAccounts([claudePin], 'local', claudeSource, rates, true).visible[0].limits
  ).toEqual(quota)
  const mismatch = createEmptyRateLimitState({
    claude: { ...quota, usageMetadata: { authProvenance: 'profile:other' } }
  })
  expect(
    projectUsagePinnedAccounts([claudePin], 'local', claudeSource, mismatch, true).visible[0].limits
  ).toBeNull()
  const cliSource = { ...claudeSource, claude: { ...claudeSource.claude, activeAccountId: null } }
  const cliRates = createEmptyRateLimitState({
    claude: { ...quota, usageMetadata: { authProvenance: 'system' } }
  })
  expect(
    projectUsagePinnedAccounts(
      [{ ...claudePin, accountId: null }],
      'local',
      cliSource,
      cliRates,
      true
    ).visible[0].limits
  ).toEqual(cliRates.claude)
})

it('includes organization context in pinned same-email Claude identities', () => {
  const snapshot: ProviderAccountsSnapshot = {
    ...source,
    claude: {
      accounts: ['First organization', 'Second organization'].map((organizationName, index) => ({
        id: `organization-${index}`,
        email: 'same@example.test',
        organizationName,
        authMethod: 'subscription-oauth' as const,
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      })),
      activeAccountId: null
    }
  }
  const pins = snapshot.claude.accounts.map((account) => ({
    ...pin,
    provider: 'claude' as const,
    accountId: account.id
  }))
  const result = projectUsagePinnedAccounts(
    pins,
    'local',
    snapshot,
    createEmptyRateLimitState(),
    true
  )
  expect(result.visible.map((entry) => entry.label)).toEqual([
    'same@example.test (First organization)',
    'same@example.test (Second organization)'
  ])
})

it.each(['profile:other', 'profile:one:wsl:Ubuntu'])(
  'rejects contradictory proof %s even on an exact-ID inactive pin sample',
  (authProvenance) => {
    const rates = createEmptyRateLimitState({
      inactiveCodexAccounts: [
        {
          accountId: 'one',
          rateLimits: limits.codex ? { ...limits.codex, usageMetadata: { authProvenance } } : null,
          updatedAt: 1,
          isFetching: false
        }
      ]
    })
    expect(
      projectUsagePinnedAccounts([pin], 'local', source, rates, true).visible[0].limits
    ).toBeNull()
  }
)
