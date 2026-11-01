// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import { useCodexSwitcherController } from './use-codex-switcher-controller'
const mocks = vi.hoisted(() => {
  const source: { snapshot: ProviderAccountsSnapshot | null } = { snapshot: null }
  return { source, refresh: vi.fn(), load: vi.fn().mockResolvedValue(undefined), accept: vi.fn() }
})
vi.mock('./use-usage-account-source', () => ({
  useUsageAccountSource: () => ({
    snapshot: mocks.source.snapshot,
    loadAccounts: mocks.load,
    acceptRoster: mocks.accept
  })
}))
vi.mock('@/runtime/use-worktree-runtime-target', () => ({
  useActiveAccountOwner: () => ({
    target: { kind: 'environment', environmentId: 'remote' },
    wslHostDistro: null
  })
}))
vi.mock('@/lib/windows-terminal-capabilities', () => ({
  useWindowsTerminalCapabilities: () => ({ wslDistros: [], isLoading: false }),
  getWindowsTerminalCapabilityOwnerKey: () => 'remote'
}))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: null,
      runtimeEnvironments: [],
      rateLimits: createEmptyRateLimitState(),
      refreshCodexRateLimitsForTarget: mocks.refresh,
      fetchInactiveCodexAccountUsage: vi.fn()
    })
}))
const provider: ProviderRateLimits = {
  provider: 'codex',
  session: null,
  weekly: null,
  status: 'error',
  error: 'Unavailable',
  updatedAt: 1
}
afterEach(() => {
  cleanup()
  mocks.source.snapshot = null
  mocks.refresh.mockReset()
})
it('keeps an unresolved remote runtime unknown and never refreshes the local runtime', async () => {
  const hook = renderHook(() => useCodexSwitcherController(provider))
  expect(hook.result.current.switchGroups).toEqual([])
  expect(hook.result.current.selectedRuntimeKey).toBe('')
  expect(hook.result.current.activeTarget).toBeUndefined()
  await hook.result.current.handleSelectRuntime({
    key: 'host',
    label: 'Remote',
    runtimeTarget: { runtime: 'host', wslDistro: null },
    targets: []
  })
  expect(mocks.refresh).not.toHaveBeenCalled()
})
it('uses only the supplied remote runtime once it becomes verified by a snapshot', () => {
  mocks.source.snapshot = {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: createEmptyRateLimitState({ codexTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' } })
  }
  const hook = renderHook(() => useCodexSwitcherController(provider))
  expect(hook.result.current.selectedRuntimeKey).toBe('wsl:Ubuntu')
  expect(hook.result.current.selectedGroup?.runtimeTarget.runtime).toBe('wsl')
  expect(mocks.refresh).not.toHaveBeenCalled()
})
