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
}

function markup(items: { host: HostProfile; snapshot: AccountsSnapshot }[]): string {
  return renderToStaticMarkup(
    createElement(MobileHomeAccountUsageCards, { items, onOpen: vi.fn() })
  )
}

it('drops a late WSL quota while the selected account changes, then shows its matching proof', () => {
  const current = snapshot()
  expect(markup([{ host: host('one'), snapshot: current }])).toContain('wsl@example.test')
  expect(markup([{ host: host('one'), snapshot: current }])).toContain('83%')

  current.codex.accounts.push({ id: 'next-account', email: 'next@example.test', updatedAt: 1 })
  current.codex.activeAccountIdsByRuntime = {
    host: 'host-account',
    wsl: { Ubuntu: 'next-account' }
  }
  const stale = markup([{ host: host('one'), snapshot: current }])
  expect(stale).toContain('next@example.test')
  expect(stale).not.toContain('wsl@example.test')
  expect(stale).not.toContain('83%')

  if (!current.rateLimits.codex) {
    throw new Error('Synthetic Codex quota missing')
  }
  current.rateLimits.codex.usageMetadata = {
    authProvenance: 'profile:next-account:wsl:Ubuntu'
  }
  expect(markup([{ host: host('one'), snapshot: current }])).toContain('83%')
})

it('hides an unproved or deleted WSL account quota without falling back to the host account', () => {
  const current = snapshot()
  if (!current.rateLimits.codex) {
    throw new Error('Synthetic Codex quota missing')
  }
  current.rateLimits.codex.usageMetadata = undefined
  expect(markup([{ host: host('one'), snapshot: current }])).not.toContain('83%')

  current.codex.activeAccountIdsByRuntime = {
    host: 'host-account',
    wsl: { Ubuntu: 'deleted-account' }
  }
  current.rateLimits.codex.usageMetadata = {
    authProvenance: 'profile:deleted-account:wsl:Ubuntu'
  }
  const deleted = markup([{ host: host('one'), snapshot: current }])
  expect(deleted).not.toContain('83%')
  expect(deleted).not.toContain('host@example.test')
})

it('keeps each host card bound to its own target and account', () => {
  const local = snapshot()
  local.rateLimits.codexTarget = { runtime: 'host', wslDistro: null }
  if (!local.rateLimits.codex) {
    throw new Error('Synthetic Codex quota missing')
  }
  local.rateLimits.codex.session = {
    usedPercent: 42,
    windowMinutes: 300,
    resetsAt: null,
    resetDescription: null
  }
  local.rateLimits.codex.usageMetadata = { authProvenance: 'profile:host-account' }
  const cards = markup([
    { host: host('local'), snapshot: local },
    { host: host('remote'), snapshot: snapshot() }
  ])
    .split('</button>')
    .filter((entry) => entry.includes('@example.test'))
  expect(cards).toHaveLength(2)
  expect(cards[0]).toContain('host@example.test')
  expect(cards[0]).toContain('42%')
  expect(cards[0]).not.toContain('83%')
  expect(cards[1]).toContain('wsl@example.test')
  expect(cards[1]).toContain('83%')
  expect(cards[1]).not.toContain('42%')
})

it('keeps a proven system login quota visible without saved accounts', () => {
  const current = snapshot()
  current.codex.accounts = []
  current.codex.activeAccountIdsByRuntime = { host: null, wsl: {} }
  current.rateLimits.codexTarget = { runtime: 'host', wslDistro: null }
  if (!current.rateLimits.codex) {
    throw new Error('Synthetic Codex quota missing')
  }
  current.rateLimits.codex.usageMetadata = { authProvenance: 'system' }
  const system = markup([{ host: host('one'), snapshot: current }])
  expect(system).toContain('System default')
  expect(system).toContain('83%')

  current.rateLimits.codex.usageMetadata = { authProvenance: 'profile:removed-account' }
  expect(markup([{ host: host('one'), snapshot: current }])).not.toContain('83%')
})
