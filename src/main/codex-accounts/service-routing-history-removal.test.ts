import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type * as OS from 'node:os'
import {
  createCodexAuthJson,
  createManagedHome,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof OS>('node:os')
  return { ...actual, homedir: () => testState.fakeHomeDir }
})
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))
describe('native gateway dialog history ownership', () => {
  registerCodexAccountsTestHomes()
  it('refuses native profile deletion before roster/home mutation until the gateway history claim drains', async () => {
    const id = '10000000-0000-4000-8000-000000000001'
    const auth = createCodexAuthJson('synthetic@example.test', 'provider-synthetic', 'synthetic')
    const path = createManagedHome(testState.userDataDir, id, '', auth)
    const sessions = join(path, 'sessions')
    mkdirSync(sessions, { recursive: true })
    const dialog = join(sessions, 'synthetic-dialog.jsonl')
    writeFileSync(dialog, '{"dialog":"preserve"}\n')
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id,
          email: 'synthetic@example.test',
          managedHomePath: path,
          providerAccountId: 'provider-synthetic',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: id
    })
    const store = createStore(settings),
      limits = createRateLimits(),
      home = createRuntimeHome()
    const { CodexAccountService } = await import('./service')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Existing account-service harness supplies the isolated store methods used by construction/removal.
    const serviceStore = store as never
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: No provider is called; the existing harness implements every rate-limit operation in this removal path.
    const serviceLimits = limits as never
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Existing runtime-home harness records sync calls without touching a native profile.
    const serviceHome = home as never
    const service = new CodexAccountService(serviceStore, serviceLimits, serviceHome)
    const { claimNativeCodexHistoryHome } =
      await import('../runtime/native-codex-routing-ownership')
    const release = claimNativeCodexHistoryHome(path)
    store.updateSettings.mockClear()
    try {
      await expect(service.removeAccount(id)).rejects.toThrow(/history before removing/)
      expect(store.updateSettings).not.toHaveBeenCalled()
      expect(store.getSettings().codexManagedAccounts).toHaveLength(1)
      expect(readFileSync(dialog, 'utf8')).toBe('{"dialog":"preserve"}\n')
      expect(readFileSync(join(path, 'auth.json'), 'utf8')).toBe(auth)
    } finally {
      release()
    }
    let commits = 0
    service.setRoutingRemoval({
      assertHistoryUnused: () => {},
      remove: (_account, commit) =>
        service.withRoutingMutation(async () => {
          commits++
          return commit()
        })
    })
    expect((await service.removeAccount(id)).accounts).toEqual([])
    expect(commits).toBe(1)
  })
})
