import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import {
  resolveWorkerCodexAccountHome,
  resolveWorkerCodexLaunchHome,
  WORKER_CODEX_ACCOUNT_ENV
} from './worker-account-home'

vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  ensureCodexStateDbBackfillRecoveryStarted: vi.fn(async () => {})
}))
import { ensureCodexStateDbBackfillRecoveryStarted } from '../codex/codex-state-db-backfill-recovery'
import { resolvePtySpawnHostEnv } from '../ipc/pty/spawn-host-env'
import { assemblePtySpawnEnvDeletions } from '../ipc/pty/spawn-options-assembly'
import { noCodexResumeLaunch } from '../ipc/pty/host-env/codex-resume'

describe('explicit worker account home', () => {
  let root: string
  let accounts: CodexManagedAccount[]
  beforeEach(() => {
    vi.mocked(ensureCodexStateDbBackfillRecoveryStarted).mockReset()
    root = mkdtempSync(join(tmpdir(), 'opka-worker-account-'))
    installFakeAppEnvironment({ getPath: () => root })
    accounts = ['first', 'second'].map((id) => {
      const managedHomePath = join(root, 'codex-accounts', id, 'home')
      mkdirSync(managedHomePath, { recursive: true })
      writeFileSync(join(managedHomePath, '.orca-managed-home'), `${id}\n`)
      writeFileSync(
        join(managedHomePath, 'auth.json'),
        JSON.stringify({ OPENAI_API_KEY: 'synthetic-test-only' })
      )
      return { id, managedHomePath, email: '', createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 }
    })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })
  it('pins the requested registered home without changing account records', () => {
    const original = JSON.stringify(accounts)
    const home = resolveWorkerCodexAccountHome(accounts, 'second')
    expect(home).toBe(accounts[1].managedHomePath)
    expect(
      resolveWorkerCodexLaunchHome({
        accounts,
        runtime: 'host',
        agent: 'codex',
        env: { CODEX_HOME: home, [WORKER_CODEX_ACCOUNT_ENV]: 'second' }
      })
    ).toBe(home)
    expect(JSON.stringify(accounts)).toBe(original)
  })
  it('does not interpret a bare caller home or ambient marker as an explicit account', () => {
    vi.stubEnv(WORKER_CODEX_ACCOUNT_ENV, 'second')
    expect(
      resolveWorkerCodexLaunchHome({
        accounts,
        runtime: 'host',
        agent: 'codex',
        env: { CODEX_HOME: accounts[1].managedHomePath }
      })
    ).toBeUndefined()
  })
  it('rejects removed accounts on a later launch validation', () => {
    const home = resolveWorkerCodexAccountHome(accounts, 'second')
    accounts.pop()
    expect(() =>
      resolveWorkerCodexLaunchHome({
        accounts,
        runtime: 'host',
        agent: 'codex',
        env: { CODEX_HOME: home, [WORKER_CODEX_ACCOUNT_ENV]: 'second' }
      })
    ).toThrow('not registered')
  })
  it('rejects unknown accounts, WSL profiles and wrong adapters', () => {
    expect(() => resolveWorkerCodexAccountHome(accounts, 'unknown')).toThrow('not registered')
    accounts[1].managedHomeRuntime = 'wsl'
    expect(() => resolveWorkerCodexAccountHome(accounts, 'second')).toThrow('not registered')
    expect(() =>
      resolveWorkerCodexLaunchHome({
        accounts,
        runtime: 'host',
        agent: 'claude',
        env: { [WORKER_CODEX_ACCOUNT_ENV]: 'first' }
      })
    ).toThrow('local Codex')
  })
  it('refuses missing credentials and forged home associations without fallback', () => {
    rmSync(join(accounts[1].managedHomePath, 'auth.json'))
    expect(() => resolveWorkerCodexAccountHome(accounts, 'second')).toThrow('needs sign-in')
    expect(() =>
      resolveWorkerCodexLaunchHome({
        accounts,
        runtime: 'host',
        agent: 'codex',
        env: { CODEX_HOME: '/other/home', [WORKER_CODEX_ACCOUNT_ENV]: 'first' }
      })
    ).toThrow('changed during launch')
  })
  it('rejects a foreign or mismatched owned-home marker', () => {
    writeFileSync(join(accounts[1].managedHomePath, '.orca-managed-home'), 'foreign-account\n')
    expect(() => resolveWorkerCodexAccountHome(accounts, 'second')).toThrow('untrusted')
    accounts[0].managedHomePath = join(root, 'foreign')
    expect(() => resolveWorkerCodexAccountHome(accounts, 'first')).toThrow('untrusted')
  })
  function launch(explicitAccount = true) {
    const selected = vi.fn(async () => accounts[0].managedHomePath)
    const result = resolvePtySpawnHostEnv({
      launchAgent: 'codex',
      command: 'codex',
      resumeProviderSession: undefined,
      env: explicitAccount
        ? { CODEX_HOME: accounts[1].managedHomePath, [WORKER_CODEX_ACCOUNT_ENV]: 'second' }
        : {},
      cwd: root,
      shellOverride: undefined,
      expectedWslDistro: null,
      codexSelectionTarget: { runtime: 'host' },
      preAdopted: false,
      isDaemonHostSpawn: false,
      sessionId: undefined,
      callerNamedSession: false,
      mintedSessionId: false,
      resumeOnSelectedAccount: false,
      emptySessionIdSkipsHostEnv: true,
      requestedAgentTeamsPath: undefined,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: window env preparation never calls the provider.
      provider: {} as never,
      deps: {
        getSettings: () => createGlobalSettingsFixture({ codexManagedAccounts: accounts }),
        getSelectedCodexHomePath: selected,
        prepareCodexResumeHome: () => null,
        noCodexResumeLaunch,
        resolveCodexResumeLaunch: async () => noCodexResumeLaunch('codex'),
        reconcileSharedRuntimeResumeHome: async () => {
          throw new Error('unexpected resume')
        },
        stripSequencedStartupResumeArgv: (env) => env
      }
    })
    return { result, selected }
  }
  it('pins the actual PTY launch home instead of global selection and strips its marker', async () => {
    const { result, selected } = launch()
    const env = await result
    expect(env.selectedCodexHomePath).toBe(accounts[1].managedHomePath)
    expect(env.codexResumeHomeSelected).toBe(true)
    expect(env.env?.[WORKER_CODEX_ACCOUNT_ENV]).toBeUndefined()
    expect(selected).not.toHaveBeenCalled()
  })
  it('revalidates after asynchronous PTY preparation instead of falling back', async () => {
    vi.mocked(ensureCodexStateDbBackfillRecoveryStarted).mockImplementationOnce(async () => {
      accounts.pop()
    })
    const { result, selected } = launch()
    await expect(result).rejects.toThrow('not registered')
    expect(selected).not.toHaveBeenCalled()
  })
  it('keeps ordinary launch selection when its parent process contains an account marker', async () => {
    vi.stubEnv(WORKER_CODEX_ACCOUNT_ENV, 'second')
    const { result, selected } = launch(false)
    const resolved = await result
    expect(resolved.selectedCodexHomePath).toBe(accounts[0].managedHomePath)
    expect(selected).toHaveBeenCalledOnce()
    expect(resolved.env?.[WORKER_CODEX_ACCOUNT_ENV]).toBeUndefined()
  })
  it.each([false, true])(
    'deletes caller and daemon-inherited markers with pinned home=%s',
    (pinned) => {
      vi.stubEnv(WORKER_CODEX_ACCOUNT_ENV, 'second')
      const callerEnvironments: Record<string, string>[] = [
        {},
        { [WORKER_CODEX_ACCOUNT_ENV]: 'second' }
      ]
      for (const env of callerEnvironments) {
        const assembled = assemblePtySpawnEnvDeletions({
          env,
          callerEnvToDelete: undefined,
          agentTeamsEnvToDelete: [],
          isDaemonHostSpawn: true,
          connectionId: null,
          skipCodexHomeEnv: false,
          stripInheritedOrcaCodexHome: false,
          codexResumeHomeSelected: pinned,
          settings: createGlobalSettingsFixture()
        })
        expect(assembled.env?.[WORKER_CODEX_ACCOUNT_ENV]).toBeUndefined()
        expect(assembled.envToDelete).toContain(WORKER_CODEX_ACCOUNT_ENV)
      }
    }
  )
})
