import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { ProviderAccountQuota } from './ProviderAccountQuota'

function usage(provenance: string): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: {
      usedPercent: 16,
      windowMinutes: 10080,
      resetsAt: 1800000000000,
      resetDescription: null
    },
    updatedAt: 1,
    status: 'ok',
    error: null,
    usageMetadata: { authProvenance: provenance }
  }
}
const roster = { accounts: [], activeAccountId: 'a' }
it('shows numeric quota and reset only for the selected account with matching identity', () => {
  const render = (provenance: string) =>
    renderToStaticMarkup(
      <ProviderAccountQuota
        provider="codex"
        accountId="a"
        model={{
          codexAccounts: roster,
          claudeAccounts: roster,
          poolUsageSnapshot: createEmptyRateLimitState({ codex: usage(provenance) })
        }}
      />
    )
  expect(render('profile:a')).toContain('16% used')
  expect(render('profile:a')).toContain('Resets')
  expect(render('profile:b')).toBe('')
})
it('uses the same-host inactive account sample without borrowing another account quota', () => {
  const state = createEmptyRateLimitState({
    codex: usage('profile:a'),
    inactiveCodexAccounts: [
      { accountId: 'b', rateLimits: usage('profile:b'), updatedAt: 1, isFetching: false }
    ]
  })
  const model = { codexAccounts: roster, claudeAccounts: roster, poolUsageSnapshot: state }
  expect(
    renderToStaticMarkup(<ProviderAccountQuota provider="codex" accountId="b" model={model} />)
  ).toContain('16% used')
  expect(
    renderToStaticMarkup(<ProviderAccountQuota provider="codex" accountId="c" model={model} />)
  ).toBe('')
})
it('shows no local or previous-host sample when the current owner has no verified snapshot', () => {
  expect(
    renderToStaticMarkup(
      <ProviderAccountQuota
        provider="codex"
        accountId="a"
        model={{ codexAccounts: roster, claudeAccounts: roster, poolUsageSnapshot: null }}
      />
    )
  ).toBe('')
})

it('does not confuse a legacy WSL selection with the selected host account', () => {
  const accounts = { ...roster, activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'a' } } }
  expect(
    renderToStaticMarkup(
      <ProviderAccountQuota
        provider="codex"
        accountId="a"
        model={{
          codexAccounts: accounts,
          claudeAccounts: roster,
          poolUsageSnapshot: createEmptyRateLimitState({ codex: usage('profile:a') })
        }}
      />
    )
  ).toBe('')
})
