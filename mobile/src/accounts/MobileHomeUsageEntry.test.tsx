import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { AccountsSnapshot } from '../components/AccountUsage'
import { mobileAccountsRouteTarget } from './mobile-accounts-route'
import { MobileHomeUsageEntry } from './MobileHomeUsageEntry'

vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  const element =
    (tag: string) =>
    ({ children }: { children: ReactNode }) =>
      createElement(tag, null, children)
  return {
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: element('span'),
    View: element('div')
  }
})

it('renders the direct account entry only for its current host, runtime and account', () => {
  const snapshot: AccountsSnapshot = {
    claude: { accounts: [], activeAccountId: null },
    codex: {
      accounts: [{ id: 'wsl-account', email: 'wsl@example.test', updatedAt: 1 }],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl-account' } }
    },
    rateLimits: {
      claude: null,
      codex: null,
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  }
  const params = mobileAccountsRouteTarget('host-one', {
    provider: 'codex',
    accountId: 'wsl-account',
    runtimeKey: 'wsl:Ubuntu'
  }).params
  const renderAccountRow = vi.fn(() => createElement('span', null, 'Direct account row'))
  const render = (hostId: string) =>
    renderToStaticMarkup(
      createElement(MobileHomeUsageEntry, {
        hostId,
        snapshot,
        usageParams: params,
        available: true,
        renderAccountRow
      })
    )

  expect(render('host-one')).toContain('Direct account row')
  expect(renderAccountRow).toHaveBeenCalledExactlyOnceWith('codex', 'wsl-account', false, true)

  renderAccountRow.mockClear()
  expect(render('other-host')).toContain('Account or runtime changed')
  expect(renderAccountRow).not.toHaveBeenCalled()

  snapshot.codex.accounts = []
  expect(render('host-one')).toContain('Account or runtime changed')
  expect(renderAccountRow).not.toHaveBeenCalled()
})
