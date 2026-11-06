import { beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configureNativeCodexRouting } from './configure-native-codex-routing'
import { installRuntimeCodexEngineHost } from './runtime-codex-engine-host'
import { assertEngineWriterIdle } from '../codex-routing/engine-writer-ownership'

const lock = vi.hoisted(() => ({ pid: process.pid, nonce: 'initial-owner' }))
vi.mock('../orcad/orcad-instance-lock', () => ({
  ORCAD_LOCK_FILE_NAME: 'orcad.lock',
  readOrcadInstanceLockRecord: () => ({ ...lock })
}))
vi.mock('./runtime-codex-engine-host', () => ({
  installRuntimeCodexEngineHost: vi.fn(),
  peekRuntimeCodexEngineHost: () => null
}))
vi.mock('../codex-routing/engine-writer-ownership', () => ({ assertEngineWriterIdle: vi.fn() }))
beforeEach(() => {
  vi.clearAllMocks()
  lock.pid = process.pid
  lock.nonce = 'initial-owner'
})
function fixture(httpProxyUrl = 'http://127.0.0.1:19877') {
  const unused = (): never => {
    throw new Error('Lazy runtime accessor was called during installation')
  }
  const runtime = { requireStore: unused, getAccountsSnapshot: unused, getOrchestrationDb: unused }
  const profile = join(tmpdir(), 'synthetic-data-root', 'profiles', 'profile-a')
  const services = {
    withRoutingMutation: async <T>(operation: () => Promise<T>) => operation(),
    setRoutingRemoval: vi.fn()
  }
  configureNativeCodexRouting(runtime, {
    store: {
      getProfileStorageDirectory: () => profile,
      getSettings: () => ({
        codexManagedAccounts: [],
        activeCodexManagedAccountId: null,
        httpProxyUrl,
        httpProxyBypassRules: 'localhost'
      })
    },
    dataRoot: join(tmpdir(), 'synthetic-data-root'),
    codexAccounts: services,
    rateLimits: { ingestCodexProviderFailure: vi.fn(() => false) }
  })
  const installed = vi.mocked(installRuntimeCodexEngineHost).mock.calls[0]?.[1]
  if (!installed) {
    throw new Error('Routing installation was not recorded')
  }
  return { installed, profile, services }
}

it('installs lazily in the selected profile and preserves configured egress and resource budgets', () => {
  const f = fixture()
  expect(f.installed).toMatchObject({
    userDataPath: f.profile,
    codexAccounts: f.services,
    memoryMiB: 128,
    maxRequestBytes: 4 * 1024 * 1024,
    networkProxySettings: {
      httpProxyUrl: 'http://127.0.0.1:19877',
      httpProxyBypassRules: 'localhost'
    }
  })
  expect(assertEngineWriterIdle).not.toHaveBeenCalled()
  expect(() => f.installed.assertExclusiveProfile()).not.toThrow()
})

it('refuses credential work after the captured host lock is replaced', () => {
  const f = fixture()
  lock.nonce = 'replacement-owner'
  expect(() => f.installed.assertExclusiveProfile()).toThrow('own this profile')
  expect(() => f.installed.assertEnrollmentIdle('10000000-0000-4000-8000-000000000001')).toThrow()
  expect(assertEngineWriterIdle).not.toHaveBeenCalled()
})

it('does not accept another process owner even if the lock nonce remains unchanged', () => {
  lock.pid = process.pid + 1
  const f = fixture()
  expect(() => f.installed.assertExclusiveProfile()).toThrow('own this profile')
})

it('proves the exact enrollment writer idle before reusing its fixed account stage', () => {
  const f = fixture()
  const account = '10000000-0000-4000-8000-000000000001'
  f.installed.assertEnrollmentIdle(account)
  expect(assertEngineWriterIdle).toHaveBeenCalledWith({
    directory: join(f.profile, 'codex-routing', 'staging', account, 'runtime'),
    assertExclusive: f.installed.assertExclusiveProfile
  })
  expect(() => f.installed.assertEnrollmentIdle('../other-account')).toThrow()
  expect(assertEngineWriterIdle).toHaveBeenCalledTimes(1)
})

it('inherits the service egress when no application proxy override is configured', () => {
  expect(fixture('').installed.networkProxySettings).toBeUndefined()
})
