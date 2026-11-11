import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { AccountsSnapshot } from '../components/AccountUsage'
import { getAccountProviderUsage } from '../components/provider-account-usage'
import type { HostProfile } from '../transport/types'
import { MobileHomeAccountUsageCards } from './MobileHomeAccountUsageCards'

vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  const element =
    (tag: string) =>
    ({ children }: { children: ReactNode }) =>
      createElement(tag, null, children)
  return {
    ActivityIndicator: element('span'),
    Pressable: element('button'),
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: element('span'),
    View: element('div')
  }
})
vi.mock('../components/AgentIcons', () => ({
  ClaudeIcon: 'ClaudeIcon',
  OpenAIIcon: 'OpenAIIcon'
}))

const host: HostProfile = {
  id: 'synthetic-host',
  name: 'Synthetic host',
  endpoint: 'wss://synthetic.example.test/mobile',
  deviceToken: 'synthetic-token',
  publicKeyB64: 'synthetic-key',
  lastConnected: 1
}

it('does not pair a host-account label with quota proven for a different WSL account', () => {
  const snapshot: AccountsSnapshot = {
    claude: {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    codex: {
      accounts: [
        { id: 'host-account', email: 'host@example.test', updatedAt: 1 },
        { id: 'wsl-account', email: 'wsl@example.test', updatedAt: 1 }
      ],
      activeAccountId: 'host-account',
      activeAccountIdsByRuntime: { host: 'host-account', wsl: { Ubuntu: 'wsl-account' } }
    },
    rateLimits: {
      claude: null,
      codex: {
        provider: 'codex',
        session: {
          usedPercent: 83,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        },
        weekly: null,
        updatedAt: 1,
        error: null,
        status: 'ok',
        usageMetadata: { authProvenance: 'profile:wsl-account:wsl:Ubuntu' }
      },
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  }
  expect(getAccountProviderUsage(snapshot, 'codex', 'host-account')).toBeNull()
  expect(getAccountProviderUsage(snapshot, 'codex', 'wsl-account')?.session?.usedPercent).toBe(83)
  const text = renderToStaticMarkup(
    createElement(MobileHomeAccountUsageCards, { items: [{ host, snapshot }], onOpen: vi.fn() })
  )
  expect(text).toContain('83%')
  expect(text).toContain('wsl@example.test')
  expect(text).not.toContain('host@example.test')
})
