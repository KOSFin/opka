import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { AccountsSnapshot } from '../components/AccountUsage'
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

function host(id: string): HostProfile {
  return {
    id,
    name: id,
    endpoint: `wss://${id}.example.test/mobile`,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected: 1
  }
}

function snapshot(): AccountsSnapshot {
  return {
    claude: {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    codex: {
      accounts: [
        { id: 'host-account', email: 'same@example.test', updatedAt: 1 },
        { id: 'wsl-account', email: 'same@example.test', updatedAt: 1 }
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
}

function markup(items: { host: HostProfile; snapshot: AccountsSnapshot }[]): string {
  return renderToStaticMarkup(
    createElement(MobileHomeAccountUsageCards, { items, onOpen: vi.fn() })
  )
}

it('never joins duplicate email identities or a different runtime proof', () => {
  const current = snapshot()
  expect(markup([{ host: host('remote'), snapshot: current }])).toContain('83%')
  if (!current.rateLimits.codex) {
    throw new Error('Missing synthetic quota')
  }
  current.rateLimits.codex.usageMetadata = { authProvenance: 'profile:host-account' }
  expect(markup([{ host: host('remote'), snapshot: current }])).not.toContain('83%')
  current.rateLimits.codex.usageMetadata = { authProvenance: 'profile:wsl-account:wsl:Debian' }
  expect(markup([{ host: host('remote'), snapshot: current }])).not.toContain('83%')
})

it('drops late, unproved and deleted account quota without borrowing a host percentage', () => {
  const current = snapshot()
  current.codex.accounts.push({ id: 'next-account', email: 'next@example.test', updatedAt: 1 })
  current.codex.activeAccountIdsByRuntime = {
    host: 'host-account',
    wsl: { Ubuntu: 'next-account' }
  }
  expect(markup([{ host: host('remote'), snapshot: current }])).not.toContain('83%')
  if (!current.rateLimits.codex) {
    throw new Error('Missing synthetic quota')
  }
  current.rateLimits.codex.usageMetadata = undefined
  expect(markup([{ host: host('remote'), snapshot: current }])).not.toContain('83%')
  current.codex.accounts = current.codex.accounts.filter((account) => account.id !== 'next-account')
  current.rateLimits.codex.usageMetadata = { authProvenance: 'profile:next-account:wsl:Ubuntu' }
  const deleted = markup([{ host: host('remote'), snapshot: current }])
  expect(deleted).not.toContain('83%')
  expect(deleted).not.toContain('host-account')
})

it('keeps each host snapshot and target separate even with identical email labels', () => {
  const local = snapshot()
  local.rateLimits.codexTarget = { runtime: 'host', wslDistro: null }
  if (!local.rateLimits.codex) {
    throw new Error('Missing synthetic quota')
  }
  local.rateLimits.codex.session = {
    usedPercent: 42,
    windowMinutes: 300,
    resetsAt: null,
    resetDescription: null
  }
  local.rateLimits.codex.usageMetadata = { authProvenance: 'profile:host-account' }
  const rows = markup([
    { host: host('local'), snapshot: local },
    { host: host('remote'), snapshot: snapshot() }
  ])
    .split('</button>')
    .filter((row) => row.includes('same@example.test'))
  expect(rows).toHaveLength(2)
  expect(rows[0]).toContain('42%')
  expect(rows[0]).not.toContain('83%')
  expect(rows[1]).toContain('83%')
  expect(rows[1]).not.toContain('42%')
})
