import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { AccountsSnapshot } from '../components/AccountUsage'
import { MobileProviderAccountRow } from './MobileProviderAccountRow'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight'
}))
vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: 'BottomDrawer'
}))

it('opens the selected account sheet immediately and closes it back to Accounts', () => {
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
  const mounted: { renderer: ReactTestRenderer | null } = { renderer: null }
  act(() => {
    mounted.renderer = create(
      createElement(MobileProviderAccountRow, {
        snapshot,
        provider: 'codex',
        accountId: 'wsl-account',
        manualSelectionBlocked: false,
        disabled: false,
        busyAccountId: null,
        now: 1,
        onSelect: vi.fn(),
        initiallyExpanded: true
      })
    )
  })
  const renderer = mounted.renderer
  if (!renderer) {
    throw new Error('Account row did not render')
  }
  const sheets = renderer.root.findAll((node) => String(node.type) === 'BottomDrawer')
  expect(sheets).toHaveLength(1)
  expect(sheets[0]?.props.visible).toBe(true)
  const close = renderer.root.findAll(
    (node) =>
      String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Close account details'
  )
  expect(close).toHaveLength(1)
  act(() => close[0]?.props.onPress())
  expect(
    renderer.root.findAll((node) => String(node.type) === 'BottomDrawer')[0]?.props.visible
  ).toBe(false)
  act(() => renderer.unmount())
})
