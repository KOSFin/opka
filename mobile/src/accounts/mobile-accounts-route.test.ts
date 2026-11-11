import { describe, expect, it, vi } from 'vitest'
import type { AccountsSnapshot } from '../components/AccountUsage'
import {
  matchingMobileAccountsUsageIntent,
  mobileAccountsRouteTarget
} from './mobile-accounts-route'
import {
  hostStackHostRoute,
  navigateToHostStackRoute,
  type HostStackNavigationState
} from '../navigation/host-stack-navigation'

function navigationHarness(initialState: HostStackNavigationState) {
  const stateListeners = new Set<() => void>()
  let state = initialState
  const navigation = {
    addListener: vi.fn((_event: 'state', listener: () => void) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    }),
    dispatch: vi.fn(),
    getState: () => state
  }
  return {
    navigation,
    setState(nextState: HostStackNavigationState) {
      state = nextState
      for (const listener of stateListeners) {
        listener()
      }
    }
  }
}

describe('mobile accounts route', () => {
  it('keeps the host id raw for the navigator to encode', () => {
    expect(mobileAccountsRouteTarget('host/one')).toEqual({
      name: '[hostId]/accounts',
      params: { hostId: 'host/one' }
    })
  })

  it('opens a concrete WSL account directly only while host, runtime and selection still match', () => {
    const snapshot: AccountsSnapshot = {
      claude: { accounts: [], activeAccountId: null },
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
        codex: null,
        claudeTarget: { runtime: 'host', wslDistro: null },
        codexTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' },
        inactiveClaudeAccounts: [],
        inactiveCodexAccounts: []
      }
    }
    const intent = {
      provider: 'codex' as const,
      accountId: 'wsl-account',
      runtimeKey: 'wsl:Ubuntu'
    }
    const route = mobileAccountsRouteTarget('host/one', intent)
    expect(route.params).toEqual({
      hostId: 'host/one',
      usageHostId: 'host/one',
      usageProvider: 'codex',
      usageAccountId: 'wsl-account',
      usageRuntimeKey: 'wsl:Ubuntu'
    })
    expect(matchingMobileAccountsUsageIntent(snapshot, 'host/one', route.params)).toEqual(intent)
    expect(matchingMobileAccountsUsageIntent(snapshot, 'other-host', route.params)).toBeNull()

    snapshot.rateLimits.codexTarget = { runtime: 'host', wslDistro: null }
    expect(matchingMobileAccountsUsageIntent(snapshot, 'host/one', route.params)).toBeNull()
    snapshot.rateLimits.codexTarget = { runtime: 'wsl', wslDistro: 'Ubuntu' }
    snapshot.codex.activeAccountIdsByRuntime = { host: 'host-account', wsl: { Ubuntu: null } }
    expect(matchingMobileAccountsUsageIntent(snapshot, 'host/one', route.params)).toBeNull()
    snapshot.codex.activeAccountIdsByRuntime = {
      host: 'host-account',
      wsl: { Ubuntu: 'wsl-account' }
    }
    snapshot.codex.accounts = snapshot.codex.accounts.filter(
      (account) => account.id !== 'wsl-account'
    )
    expect(matchingMobileAccountsUsageIntent(snapshot, 'host/one', route.params)).toBeNull()
  })

  it('mounts the host before replacing it with the accounts route', () => {
    const harness = navigationHarness({ index: 0, routes: [{ name: 'index' }] })
    const push = vi.fn()

    navigateToHostStackRoute(
      harness.navigation,
      { push, replace: vi.fn() },
      'host/one',
      mobileAccountsRouteTarget('host/one')
    )

    expect(push).toHaveBeenCalledWith(hostStackHostRoute('host/one'))
    expect(harness.navigation.dispatch).not.toHaveBeenCalled()

    harness.setState({
      index: 1,
      routes: [
        { name: 'index' },
        {
          name: 'h',
          state: {
            key: '/h',
            index: 0,
            routes: [
              {
                key: 'host-index',
                name: '[hostId]/index',
                params: { hostId: encodeURIComponent('host/one') }
              }
            ]
          }
        }
      ]
    })

    expect(harness.navigation.dispatch).toHaveBeenCalledWith({
      type: 'REPLACE',
      target: '/h',
      source: 'host-index',
      payload: mobileAccountsRouteTarget('host/one')
    })
  })
})
