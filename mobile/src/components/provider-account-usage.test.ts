import { describe, expect, it } from 'vitest'
import type { AccountsSnapshot } from './accounts-snapshot'
import { getAccountProviderUsage, getProviderAccountSelection } from './provider-account-usage'

function snapshot(provenance?: string): AccountsSnapshot {
  return {
    claude: { accounts: [], activeAccountId: null },
    codex: {
      accounts: [],
      activeAccountId: 'b',
      activeAccountIdsByRuntime: { host: 'b', wsl: {} }
    },
    rateLimits: {
      claude: null,
      codex: {
        provider: 'codex',
        session: null,
        weekly: null,
        updatedAt: 10,
        status: 'ok',
        error: null,
        usageMetadata: { authProvenance: provenance }
      },
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  }
}

describe('named account usage ownership', () => {
  it('does not relabel previous or untagged active quota after an account switch', () => {
    expect(getAccountProviderUsage(snapshot('profile:a'), 'codex', 'b')).toBeNull()
    expect(getAccountProviderUsage(snapshot(), 'codex', 'b')).toBeNull()
    const current = snapshot('profile:b')
    expect(getAccountProviderUsage(current, 'codex', 'b')).toBe(current.rateLimits.codex)
  })

  it('keeps exact-ID inactive samples available without trusting another active account', () => {
    const current = snapshot()
    current.rateLimits.inactiveCodexAccounts = [
      { accountId: 'b', rateLimits: current.rateLimits.codex, updatedAt: 10, isFetching: false }
    ]
    expect(getAccountProviderUsage(current, 'codex', 'b')).toBe(current.rateLimits.codex)
    if (current.rateLimits.codex) {
      current.rateLimits.codex.usageMetadata = { authProvenance: 'profile:a' }
    }
    expect(getAccountProviderUsage(current, 'codex', 'b')).toBeNull()
  })

  it('resolves each provider target independently and requires exact WSL provenance', () => {
    const current = snapshot('profile:b')
    current.codex.activeAccountIdsByRuntime = { host: 'b', wsl: { Ubuntu: 'wsl-b' } }
    current.rateLimits.codexTarget = { runtime: 'wsl', wslDistro: 'Ubuntu' }
    expect(getProviderAccountSelection(current, 'codex')).toEqual({
      runtimeKey: 'wsl:Ubuntu',
      accountId: 'wsl-b'
    })
    expect(getAccountProviderUsage(current, 'codex', 'wsl-b')).toBeNull()
    if (current.rateLimits.codex) {
      current.rateLimits.codex.usageMetadata = { authProvenance: 'profile:wsl-b:wsl:Ubuntu' }
    }
    expect(getAccountProviderUsage(current, 'codex', 'wsl-b')).toBe(current.rateLimits.codex)
    expect(getProviderAccountSelection(current, 'claude')).toEqual({
      runtimeKey: 'host',
      accountId: null
    })
  })

  it('distinguishes the normal CLI login from a previously selected profile', () => {
    const current = snapshot('profile:b')
    current.codex.activeAccountIdsByRuntime = { host: null, wsl: {} }
    expect(getAccountProviderUsage(current, 'codex', null)).toBeNull()
    if (current.rateLimits.codex) {
      current.rateLimits.codex.usageMetadata = { authProvenance: 'system' }
    }
    expect(getAccountProviderUsage(current, 'codex', null)).toBe(current.rateLimits.codex)
  })
})
