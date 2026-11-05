import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildDefaultSettings } from '../../shared/default-global-settings'
import { getDefaultNotificationSettings } from '../../shared/notification-settings-defaults'
import { createEmptyRateLimitState } from '../../shared/rate-limit-state-factory'
import type { AccountsSnapshot } from './runtime-account-controller'
import type { CodexEngineHostOptions } from '../codex-routing/codex-engine-host'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import {
  getRuntimeCodexEngineHost,
  installRuntimeCodexEngineHost,
  prepareRuntimeCodexNativeLaunch,
  stopRuntimeCodexEngineHost
} from './runtime-codex-engine-host'

const captured = vi.hoisted(() => new Array<CodexEngineHostOptions>())
const failure = vi.hoisted(() => ({ stop: false }))
vi.mock('../codex-routing/codex-engine-capability', () => ({
  supportsCodexEngineGateway: () => true
}))
vi.mock('../codex-routing/codex-engine-host', () => ({
  CodexEngineHost: class {
    constructor(private options: CodexEngineHostOptions) {
      captured.push(options)
    }
    async prepareNativeLaunch(launch: { launchId: string }) {
      const state = this.options.readSelectionState(launch.launchId)
      if (!state.policy && !state.manualAccountId) {
        return null
      }
      return {
        baseUrl: 'http://127.0.0.1:12345/v1',
        apiKey: 'synthetic'.repeat(8),
        close: vi.fn(),
        revoke: vi.fn(async () => {}),
        notifyBoundaryChanged: vi.fn()
      }
    }
    async stop() {
      if (failure.stop) {
        throw new Error('unverifiable writer')
      }
    }
    beginShutdown() {
      return null
    }
  }
}))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  failure.stop = false
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  captured.length = 0
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'opka-runtime-engine-'))
  const db = new OrchestrationDb(':memory:')
  const settings = buildDefaultSettings({
    workspaceDir: directory,
    appFontFamily: 'system',
    editorAutoSaveDelayMs: 1,
    primarySelectionMiddleClickPaste: false,
    primarySelectionDefaultedForLinux: false,
    terminalFontFamily: 'monospace',
    terminalInactivePaneOpacity: 1,
    terminalRightClickToPaste: false,
    notifications: getDefaultNotificationSettings(),
    voice: {
      enabled: false,
      sttModel: '',
      modelsDir: '',
      language: '',
      dictationMode: 'toggle',
      terminalConfirmBeforeInsert: true,
      userModels: [],
      openAiApiKeyConfigured: false,
      microphoneDeviceId: null,
      microphoneDeviceLabel: null
    }
  })
  settings.codexManagedAccounts = [
    {
      id: '10000000-0000-4000-8000-000000000001',
      email: 'synthetic@example.test',
      managedHomePath: '/unused',
      providerAccountId: 'provider',
      createdAt: 1,
      updatedAt: 2,
      lastAuthenticatedAt: 3
    },
    {
      id: '10000000-0000-4000-8000-000000000002',
      email: 'wsl@example.test',
      managedHomePath: '/unused-wsl',
      managedHomeRuntime: 'wsl',
      providerAccountId: 'wsl-provider',
      createdAt: 1,
      updatedAt: 2,
      lastAuthenticatedAt: 3
    }
  ]
  const snapshot: AccountsSnapshot = {
    claude: { accounts: [], activeAccountId: null },
    codex: {
      accounts: settings.codexManagedAccounts,
      activeAccountId: settings.codexManagedAccounts[0].id
    },
    rateLimits: createEmptyRateLimitState()
  }
  const runtime = {
    requireStore: () => ({ getSettings: () => settings }),
    getAccountsSnapshot: () => snapshot,
    getOrchestrationDb: () => db
  }
  const callbacks: (() => Promise<void>)[] = []
  let mutations = 0
  installRuntimeCodexEngineHost(runtime, {
    userDataPath: directory,
    memoryMiB: 128,
    maxRequestBytes: 65536,
    assertExclusiveProfile: () => {},
    assertEnrollmentIdle: () => {},
    registerCleanup: (cleanup) => callbacks.push(cleanup),
    codexAccounts: {
      setRoutingRemoval: vi.fn(),
      withRoutingMutation: async (operation) => {
        mutations++
        return operation()
      }
    }
  })
  cleanups.push(async () => {
    await stopRuntimeCodexEngineHost(runtime)
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { runtime, settings, snapshot, directory, callbacks, mutations: () => mutations }
}
it('installs lazily and reuses one execution-host owner through its registered shutdown callback', async () => {
  const f = fixture()
  expect(captured).toHaveLength(0)
  expect(getRuntimeCodexEngineHost(f.runtime)).toBe(getRuntimeCodexEngineHost(f.runtime))
  expect(captured).toHaveLength(1)
  expect(f.callbacks).toHaveLength(1)
  await f.callbacks[0]()
  expect(getRuntimeCodexEngineHost(f.runtime)).toBeNull()
})
it('reuses the native account roster and auth revision while excluding WSL-only entries', async () => {
  const f = fixture()
  getRuntimeCodexEngineHost(f.runtime)
  const options = captured[0]
  expect(options.listAccounts()).toHaveLength(1)
  const original = options.listAccounts()[0]
  f.settings.codexManagedAccounts![0].updatedAt++
  expect(options.readAccount(original.id)?.rosterRevision).toBe(original.rosterRevision)
  f.settings.codexManagedAccounts![0].lastAuthenticatedAt++
  expect(options.readAccount(original.id)?.rosterRevision).not.toBe(original.rosterRevision)
  await options.withAccountMutationLease(async () => true)
  expect(f.mutations()).toBe(1)
})
it('keeps launch selection explicit and releases context only after verified tree exit', async () => {
  const f = fixture()
  const prepared = await prepareRuntimeCodexNativeLaunch(f.runtime, {
    launchId: 'native',
    ownerPrefix: 'native',
    canSwitch: () => true,
    accountId: 'explicit-account'
  })
  expect(prepared).not.toBeNull()
  const read = () => captured[0].readSelectionState('native')
  expect(read()).toMatchObject({ manualAccountId: 'explicit-account', policy: undefined })
  prepared?.close('unverifiable')
  expect(read().manualAccountId).toBe('explicit-account')
  prepared?.close('exited')
  expect(read).toThrow(/ownership/)
})
it('retains the owner installation when shutdown cannot prove writer exit', async () => {
  const f = fixture()
  const host = getRuntimeCodexEngineHost(f.runtime)
  failure.stop = true
  await expect(stopRuntimeCodexEngineHost(f.runtime)).rejects.toThrow(/unverifiable/)
  expect(getRuntimeCodexEngineHost(f.runtime)).toBe(host)
})
