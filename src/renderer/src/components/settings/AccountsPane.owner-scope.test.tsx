// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState,
  CodexManagedAccountSummary,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { AccountsPane } from './AccountsPane'
import type { SettingsHostScope } from './settings-host-scope'

// Why: focus deliberately points at another server; the pane must follow hostScope only.
const focusedElsewhere = {
  ...getDefaultSettings('/synthetic'),
  activeRuntimeEnvironmentId: 'focused-server'
}
const scopeFor = (environmentId: string | null): SettingsHostScope => ({
  target: environmentId ? { kind: 'environment', environmentId } : { kind: 'local' },
  available: true
})
const renderPane = (scope: SettingsHostScope): React.JSX.Element => (
  <AccountsPane settings={focusedElsewhere} updateSettings={vi.fn()} hostScope={scope} />
)

const fake = vi.hoisted(() => {
  const state: {
    query: string
    pendingSelect: ((roster: unknown) => void) | null
    pendingCodexSelect: ((roster: unknown) => void) | null
    write: ReturnType<typeof vi.fn>
    rosters: Map<string, unknown>
    codexRosters: Map<string, unknown>
    watchedTargets: unknown[]
    snapshots: ((snapshot: unknown) => void)[]
    selects: unknown[][]
  } = {
    query: 'claude',
    pendingSelect: null,
    pendingCodexSelect: null,
    write: vi.fn(),
    rosters: new Map(),
    codexRosters: new Map(),
    watchedTargets: [],
    snapshots: [],
    selects: []
  }
  return state
})
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: vi.fn(async () => false),
  callRuntimeRpc: async (target: RuntimeClientTarget, method: string) => {
    if (method === 'settings.get') {
      return { settings: {} }
    }
    if (method !== 'accountPool.list') {
      return {}
    }
    const claude = fake.rosters.get(target.kind === 'environment' ? target.environmentId : 'local')
    return {
      capability: 'orchestration.account-pools.v1',
      policies: [],
      accounts: {
        claude,
        codex: fake.codexRosters.get(
          target.kind === 'environment' ? target.environmentId : 'local'
        ) ?? { accounts: [], activeAccountId: null }
      },
      candidates: [],
      assignments: []
    }
  }
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('@/lib/codex-session-restart', () => ({
  markLiveCodexSessionsForRestart: vi.fn(async () => {}),
  resolveCodexRestartPromptAccountLabel: () => 'Codex account'
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settingsSearchQuery: fake.query,
      rateLimits: {
        codex: null,
        codexTarget: { runtime: 'host', wslDistro: null },
        minimax: null,
        cursor: { updatedAt: 0 },
        grok: { updatedAt: 0 }
      },
      runtimeEnvironments: [],
      recordFeatureInteraction: fake.write,
      fetchSettings: fake.write
    })
}))
vi.mock('@/runtime/runtime-provider-accounts-client', () => {
  const empty = () => ({
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  })
  return {
    emptyClaudeAccountsState: empty,
    emptyCodexAccountsState: empty,
    getProviderAccountsOwnerKey: (target: RuntimeClientTarget) =>
      target.kind === 'environment' ? target.environmentId : 'local',
    watchProviderAccounts: (
      target: RuntimeClientTarget,
      handlers: { onSnapshot: (snapshot: unknown) => void }
    ) => {
      fake.watchedTargets.push(target)
      fake.snapshots.push(handlers.onSnapshot)
      handlers.onSnapshot({
        claude: fake.rosters.get(target.kind === 'environment' ? target.environmentId : 'local'),
        codex:
          fake.codexRosters.get(target.kind === 'environment' ? target.environmentId : 'local') ??
          empty(),
        rateLimits: null
      })
      return { close: vi.fn() }
    },
    selectClaudeProviderAccount: (...args: unknown[]) => {
      fake.selects.push(args)
      return new Promise((resolve) => {
        fake.pendingSelect = resolve
      })
    },
    selectCodexProviderAccount: () =>
      new Promise((resolve) => {
        fake.pendingCodexSelect = resolve
      }),
    removeClaudeProviderAccount: fake.write,
    removeCodexProviderAccount: fake.write
  }
})

function claudeRoster(id: string, email: string, active: boolean): ClaudeRateLimitAccountsState {
  const account: ClaudeManagedAccountSummary = {
    id,
    email,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
  const activeId = active ? id : null
  return {
    accounts: [account],
    activeAccountId: activeId,
    activeAccountIdsByRuntime: { host: activeId, wsl: {} }
  }
}

function codexRoster(id: string, email: string, active: boolean): CodexRateLimitAccountsState {
  const account: CodexManagedAccountSummary = {
    id,
    email,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
  const activeId = active ? id : null
  return {
    accounts: [account],
    activeAccountId: activeId,
    activeAccountIdsByRuntime: { host: activeId, wsl: {} }
  }
}

beforeEach(() => {
  fake.query = 'claude'
  fake.pendingSelect = null
  fake.pendingCodexSelect = null
  fake.watchedTargets = []
  fake.snapshots = []
  fake.selects = []
  fake.codexRosters.clear()
  fake.rosters.set('local', claudeRoster('acct-l', 'local@desktop.test', false))
  fake.rosters.set('server-a', claudeRoster('acct-a', 'alpha@server-a.test', false))
  fake.rosters.set('server-b', claudeRoster('acct-b', 'beta@server-b.test', false))
  Object.assign(window, {
    api: {
      minimaxCredentials: {
        getStatus: vi.fn(async () => ({ cookieConfigured: false, apiKeyConfigured: false }))
      },
      codexConfigSync: {
        status: vi.fn(async () => ({ state: 'synced', reason: null, systemConfigPath: '/x' }))
      }
    }
  })
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

it('lists the accounts of the host chosen in the page, not the focused server', async () => {
  render(renderPane(scopeFor(null)))
  await act(async () => {})
  expect(screen.getByText('local@desktop.test')).toBeTruthy()
  expect(fake.watchedTargets).toEqual([{ kind: 'local' }])
})

it("drops a server's late account result after the page moves to another server", async () => {
  const view = render(renderPane(scopeFor('server-a')))
  await act(async () => {})
  fireEvent.click(
    within(screen.getByRole('group', { name: 'alpha@server-a.test' })).getByRole('button', {
      name: 'Use for new chats'
    })
  )
  expect(fake.pendingSelect).not.toBeNull()

  await act(async () => view.rerender(renderPane(scopeFor('server-b'))))
  expect(screen.getByText('beta@server-b.test')).toBeTruthy()

  await act(async () => fake.pendingSelect?.(claudeRoster('acct-a', 'alpha@server-a.test', true)))

  // Server A's roster must not replace server B's in the pane now scoped to B.
  expect(screen.queryByText('alpha@server-a.test')).toBeNull()
  expect(screen.getByText('beta@server-b.test')).toBeTruthy()
})

it('allows a fresh action after returning to a server while dropping the earlier result', async () => {
  const view = render(renderPane(scopeFor('server-a')))
  await act(async () => {})
  fireEvent.click(
    within(screen.getByRole('group', { name: 'alpha@server-a.test' })).getByRole('button', {
      name: 'Use for new chats'
    })
  )
  for (const environmentId of ['server-b', 'server-a']) {
    await act(async () => view.rerender(renderPane(scopeFor(environmentId))))
  }
  const alphaRow = () => screen.getByRole('group', { name: 'alpha@server-a.test' })
  expect(within(alphaRow()).queryByText('Default for new chats')).toBeNull()

  await act(async () => fake.pendingSelect?.(claudeRoster('acct-a', 'alpha@server-a.test', true)))
  expect(within(alphaRow()).queryByText('Default for new chats')).toBeNull()

  fireEvent.click(within(alphaRow()).getByRole('button', { name: 'Use for new chats' }))
  expect(fake.selects).toHaveLength(2)
  await act(async () => fake.pendingSelect?.(claudeRoster('acct-a', 'alpha@server-a.test', true)))
  expect(within(alphaRow()).getByText('Default for new chats')).toBeTruthy()
})

it('ignores a closed watcher after returning to the same server', async () => {
  const view = render(renderPane(scopeFor('server-a')))
  await act(async () => {})
  const oldSnapshot = fake.snapshots[0]
  await act(async () => view.rerender(renderPane(scopeFor('server-b'))))
  fake.rosters.set('server-a', claudeRoster('acct-new', 'new@server-a.test', false))
  await act(async () => view.rerender(renderPane(scopeFor('server-a'))))
  expect(screen.getByText('new@server-a.test')).toBeTruthy()

  await act(async () =>
    oldSnapshot?.({
      claude: claudeRoster('acct-a', 'alpha@server-a.test', false),
      codex: { accounts: [], activeAccountId: null },
      rateLimits: null
    })
  )
  expect(screen.getByText('new@server-a.test')).toBeTruthy()
  expect(screen.queryByText('alpha@server-a.test')).toBeNull()
})

it('keeps newer Claude watcher fields over a late reply for the same pool member', async () => {
  render(renderPane(scopeFor('server-a')))
  await act(async () => {})
  fireEvent.click(
    within(screen.getByRole('group', { name: 'alpha@server-a.test' })).getByRole('button', {
      name: 'Use for new chats'
    })
  )
  expect(fake.pendingSelect).not.toBeNull()
  await act(async () => {
    fake.snapshots.at(-1)?.({
      claude: claudeRoster('acct-a', 'fresh@server-a.test', false),
      codex: { accounts: [], activeAccountId: null },
      rateLimits: null
    })
  })
  expect(screen.getByText('fresh@server-a.test')).toBeTruthy()
  await act(async () => fake.pendingSelect?.(claudeRoster('acct-a', 'alpha@server-a.test', true)))
  expect(screen.getByText('fresh@server-a.test')).toBeTruthy()
  expect(screen.queryByText('alpha@server-a.test')).toBeNull()
})

it('keeps a newer Codex watcher identity over a late action reply and clears busy state', async () => {
  fake.query = 'codex'
  fake.codexRosters.set('server-a', codexRoster('acct-a', 'old@server-a.test', false))
  render(renderPane(scopeFor('server-a')))
  await act(async () => {})
  fireEvent.click(
    within(screen.getByRole('group', { name: 'old@server-a.test' })).getByRole('button', {
      name: 'Use for new chats'
    })
  )
  expect(fake.pendingCodexSelect).not.toBeNull()
  const replacement = codexRoster('acct-a', 'readded@server-a.test', false)
  await act(async () => {
    fake.snapshots.at(-1)?.({
      claude: fake.rosters.get('server-a'),
      codex: replacement,
      rateLimits: null
    })
  })
  const currentButton = () =>
    within(screen.getByRole('group', { name: 'readded@server-a.test' })).getByRole('button', {
      name: 'Use for new chats'
    })
  expect(currentButton().hasAttribute('disabled')).toBe(true)
  await act(async () => fake.pendingCodexSelect?.(codexRoster('acct-a', 'old@server-a.test', true)))
  expect(screen.queryByText('old@server-a.test')).toBeNull()
  expect(screen.getByText('readded@server-a.test')).toBeTruthy()
  expect(currentButton().hasAttribute('disabled')).toBe(false)
})

it('publishes a current Codex action reply when no newer watcher arrives', async () => {
  fake.query = 'codex'
  fake.codexRosters.set('server-a', codexRoster('acct-a', 'codex@server-a.test', false))
  render(renderPane(scopeFor('server-a')))
  await act(async () => {})
  fireEvent.click(
    within(screen.getByRole('group', { name: 'codex@server-a.test' })).getByRole('button', {
      name: 'Use for new chats'
    })
  )
  await act(async () =>
    fake.pendingCodexSelect?.(codexRoster('acct-a', 'codex@server-a.test', true))
  )
  expect(
    within(screen.getByRole('group', { name: 'codex@server-a.test' })).getByText(
      'Default for new chats'
    )
  ).toBeTruthy()
})

it('does not treat a failed Claude watcher half as a newer roster', async () => {
  render(renderPane(scopeFor('server-a')))
  await act(async () => {})
  fireEvent.click(
    within(screen.getByRole('group', { name: 'alpha@server-a.test' })).getByRole('button', {
      name: 'Use for new chats'
    })
  )
  await act(async () => {
    fake.snapshots.at(-1)?.({
      claude: claudeRoster('missing', 'missing@server-a.test', false),
      codex: { accounts: [], activeAccountId: null },
      rateLimits: null,
      failedProviders: ['claude']
    })
  })
  await act(async () => fake.pendingSelect?.(claudeRoster('acct-a', 'alpha@server-a.test', true)))
  expect(screen.queryByText('missing@server-a.test')).toBeNull()
  expect(
    within(screen.getByRole('group', { name: 'alpha@server-a.test' })).getByText(
      'Default for new chats'
    )
  ).toBeTruthy()
})

it("shows a WSL host's distro accounts from this desktop and selects for that distro", async () => {
  const roster = claudeRoster('acct-w', 'wsl@ubuntu.test', false)
  roster.accounts = roster.accounts.map((account) => ({
    ...account,
    managedAuthRuntime: 'wsl',
    wslDistro: 'Ubuntu'
  }))
  fake.rosters.set('local', roster)
  render(
    <AccountsPane
      settings={focusedElsewhere}
      updateSettings={vi.fn()}
      hostScope={scopeFor(null)}
      wslHostDistro="Ubuntu"
      wslSupportedPlatform
      wslAvailable
      wslDistros={['Ubuntu']}
    />
  )
  await act(async () => {})
  expect(fake.watchedTargets).toEqual([{ kind: 'local' }])
  fireEvent.click(
    within(screen.getByRole('group', { name: 'wsl@ubuntu.test' })).getByRole('button', {
      name: 'Use for new chats'
    })
  )
  expect(fake.selects).toEqual([
    [{ kind: 'local' }, { accountId: 'acct-w', runtime: 'wsl', wslDistro: 'Ubuntu' }]
  ])
})

it('reading an account identity does not select it', async () => {
  render(renderPane(scopeFor('server-a')))
  await act(async () => {})
  fireEvent.click(screen.getByText('alpha@server-a.test'))
  expect(fake.selects).toEqual([])
  fireEvent.click(
    within(screen.getByRole('group', { name: 'alpha@server-a.test' })).getByRole('button', {
      name: 'Use for new chats'
    })
  )
  expect(fake.selects).toHaveLength(1)
})
