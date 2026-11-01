import { expect, it } from 'vitest'
import { accountPoolCandidates } from './account-pool-candidates'
import type { AccountsSnapshot } from './runtime-account-controller'
import { createEmptyRateLimitState } from '../../shared/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
function snapshot(provenance?: string): AccountsSnapshot {
  const usage: ProviderRateLimits = {
    provider: 'codex',
    session: { usedPercent: 15, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    status: 'ok',
    error: null,
    updatedAt: Date.now(),
    usageMetadata: provenance ? { authProvenance: provenance } : undefined
  }
  return {
    claude: { accounts: [], activeAccountId: null },
    codex: {
      accounts: [
        { id: 'b', email: 'b@example.test', createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 }
      ],
      activeAccountId: 'b'
    },
    rateLimits: createEmptyRateLimitState({ codex: usage })
  }
}
it('does not assign the previous or untagged active quota to a newly selected profile', () => {
  expect(accountPoolCandidates(snapshot('profile:a'))[0]).toMatchObject({
    accountId: 'b',
    quota: 'unknown'
  })
  expect(accountPoolCandidates(snapshot())[0]).toMatchObject({ quota: 'unknown' })
  expect(accountPoolCandidates(snapshot('profile:b'))[0]).toMatchObject({
    quota: 'available',
    usedPercent: 15
  })
})
it('retains exact-ID inactive compatibility while the active source is unresolved', () => {
  const source = snapshot()
  source.rateLimits.inactiveCodexAccounts = [
    {
      accountId: 'b',
      rateLimits: source.rateLimits.codex,
      updatedAt: Date.now(),
      isFetching: false
    }
  ]
  expect(accountPoolCandidates(source)[0]).toMatchObject({ quota: 'available', usedPercent: 15 })
})

it.each(['profile:a', 'profile:b:wsl:Ubuntu'])(
  'rejects contradictory inactive proof %s before making pool quota available',
  (authProvenance) => {
    const source = snapshot()
    source.rateLimits.inactiveCodexAccounts = [
      {
        accountId: 'b',
        rateLimits: source.rateLimits.codex
          ? { ...source.rateLimits.codex, usageMetadata: { authProvenance } }
          : null,
        updatedAt: Date.now(),
        isFetching: false
      }
    ]
    expect(accountPoolCandidates(source)[0]).toMatchObject({ quota: 'unknown', usedPercent: null })
  }
)
