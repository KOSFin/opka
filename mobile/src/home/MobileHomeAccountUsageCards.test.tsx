import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { AccountsSnapshot } from '../components/AccountUsage'
import type { HostProfile } from '../transport/types'
import { MobileHomeAccountUsageCards } from './MobileHomeAccountUsageCards'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('../components/AgentIcons', () => ({
  ClaudeIcon: 'ClaudeIcon',
  OpenAIIcon: 'OpenAIIcon'
}))

const snapshot: AccountsSnapshot = {
  claude: {
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  },
  codex: {
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  },
  rateLimits: {
    claude: null,
    codex: null,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}

function host(id: string, name: string): HostProfile {
  return {
    id,
    name,
    endpoint: `wss://${id}.example.test/mobile`,
    deviceToken: `token-${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected: 1
  }
}

it('opens the selected host from its accessible Usage card', () => {
  const onOpen = vi.fn()
  const mounted: { renderer: ReactTestRenderer | null } = { renderer: null }
  act(() => {
    mounted.renderer = create(
      createElement(MobileHomeAccountUsageCards, {
        items: [
          { host: host('desk', 'Desk'), snapshot },
          { host: host('server', 'Server'), snapshot }
        ],
        onOpen
      })
    )
  })
  const renderer = mounted.renderer
  if (!renderer) {
    throw new Error('Usage cards did not render')
  }
  const cards = renderer.root.findAll(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityRole === 'button'
  )
  expect(cards.map((card) => card.props.accessibilityLabel)).toEqual([
    'Open Desk account usage',
    'Open Server account usage'
  ])
  act(() => cards[1]?.props.onPress())
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('server')
  act(() => renderer.unmount())
})

it('opens the selected WSL account usage directly with its host and runtime identity', () => {
  const wslSnapshot = structuredClone(snapshot)
  wslSnapshot.codex.accounts = [
    { id: 'host-account', email: 'host@example.test', updatedAt: 1 },
    { id: 'wsl-account', email: 'wsl@example.test', updatedAt: 1 }
  ]
  wslSnapshot.codex.activeAccountId = 'host-account'
  wslSnapshot.codex.activeAccountIdsByRuntime = {
    host: 'host-account',
    wsl: { Ubuntu: 'wsl-account' }
  }
  wslSnapshot.rateLimits.codexTarget = { runtime: 'wsl', wslDistro: 'Ubuntu' }
  const onOpen = vi.fn()
  const mounted: { renderer: ReactTestRenderer | null } = { renderer: null }
  act(() => {
    mounted.renderer = create(
      createElement(MobileHomeAccountUsageCards, {
        items: [{ host: host('remote', 'Remote'), snapshot: wslSnapshot }],
        onOpen
      })
    )
  })
  const renderer = mounted.renderer
  if (!renderer) {
    throw new Error('Usage cards did not render')
  }
  const entry = renderer.root.findAll(
    (node) =>
      String(node.type) === 'Pressable' &&
      node.props.accessibilityLabel === 'Show wsl@example.test codex usage on Remote'
  )
  expect(entry).toHaveLength(1)
  act(() => entry[0]?.props.onPress())
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('remote', {
    provider: 'codex',
    accountId: 'wsl-account',
    runtimeKey: 'wsl:Ubuntu'
  })
  act(() => renderer.unmount())
})
