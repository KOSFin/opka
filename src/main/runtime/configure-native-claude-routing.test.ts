import { beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configureNativeClaudeRouting } from './configure-native-claude-routing'
import {
  configureRuntimeClaudeNativeSources,
  shutdownRuntimeClaudeNativeSources
} from './runtime-claude-native-sources'

const lock = vi.hoisted(() => ({ pid: process.pid, nonce: 'initial-owner' }))
const launcher = vi.hoisted(() => ({ path: '/synthetic/owned-opka', available: true }))
vi.mock('../../shared/app-environment', () => ({
  hasAppEnvironment: () => launcher.available,
  getAppEnvironment: () => ({ getCliLauncherPath: () => launcher.path })
}))
vi.mock('../orcad/orcad-instance-lock', () => ({
  ORCAD_LOCK_FILE_NAME: 'orcad.lock',
  readOrcadInstanceLockRecord: () => ({ ...lock })
}))
vi.mock('./runtime-claude-native-sources', () => ({
  configureRuntimeClaudeNativeSources: vi.fn(),
  shutdownRuntimeClaudeNativeSources: vi.fn()
}))
beforeEach(() => {
  vi.clearAllMocks()
  lock.pid = process.pid
  lock.nonce = 'initial-owner'
  launcher.available = true
})
function fixture() {
  const runtime = {}
  const profile = join(tmpdir(), 'synthetic-data-root', 'profiles', 'claude-a')
  const accounts = {
    listAccounts: () => ({ accounts: [], activeAccountId: null }),
    withNativeRoutingMutation: async <T>(operation: () => Promise<T>) => operation(),
    cancelPendingLogin: vi.fn(() => false)
  }
  const cleanup: (() => Promise<void>)[] = []
  configureNativeClaudeRouting(runtime, {
    store: { getProfileStorageDirectory: () => profile },
    dataRoot: join(tmpdir(), 'synthetic-data-root'),
    claudeAccounts: accounts,
    registerCleanup: (callback) => cleanup.push(callback)
  })
  const options = vi.mocked(configureRuntimeClaudeNativeSources).mock.calls[0]?.[1]
  if (!options) {
    throw new Error('Native Claude configuration missing')
  }
  return { runtime, profile, accounts, cleanup, options }
}

it('configures a lazy profile-local source without adopting another profile', () => {
  const f = fixture()
  expect(f.options.dataRoot).toBe(f.profile)
  expect(f.options.accounts).toBe(f.accounts)
  expect(() => f.options.assertExclusiveProfile()).not.toThrow()
  expect(shutdownRuntimeClaudeNativeSources).not.toHaveBeenCalled()
})

it('refuses source work after a host lock replacement', () => {
  const f = fixture()
  lock.nonce = 'replacement'
  expect(() => f.options.assertExclusiveProfile()).toThrow('own this profile')
})

it('uses only the host launcher and refuses an unavailable host environment', () => {
  const f = fixture()
  expect(f.options.resolveHookLaunch?.()).toEqual({ command: launcher.path, args: [] })
  launcher.available = false
  expect(f.options.resolveHookLaunch?.()).toBeNull()
})

it('rejects a different host process', () => {
  lock.pid++
  const f = fixture()
  expect(() => f.options.assertExclusiveProfile()).toThrow('own this profile')
})

it('cancels legacy native login before waiting on the shared source mutation queue', async () => {
  const f = fixture()
  vi.mocked(shutdownRuntimeClaudeNativeSources).mockImplementation(async () => {
    expect(f.accounts.cancelPendingLogin).toHaveBeenCalledTimes(1)
  })
  await f.cleanup[0]()
  expect(shutdownRuntimeClaudeNativeSources).toHaveBeenCalledWith(f.runtime)
})
