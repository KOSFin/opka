import { afterEach, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { installNativeCodexHomeContext } from '../../runtime/native-codex-home-context'
import {
  registerNativeCodexRoutingOwner,
  revokeNativeCodexRoutingLaunch
} from '../../runtime/native-codex-routing-ownership'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { noCodexResumeLaunch } from './host-env/codex-resume'
import { resolvePtySpawnHostEnv } from './spawn-host-env'
import { ensureCodexStateDbBackfillRecoveryStarted } from '../../codex/codex-state-db-backfill-recovery'

vi.mock('../../codex/codex-state-db-backfill-recovery', () => ({
  ensureCodexStateDbBackfillRecoveryStarted: vi.fn(async () => {})
}))
afterEach(() => vi.mocked(ensureCodexStateDbBackfillRecoveryStarted).mockReset())

function fixture() {
  const nativeHome = resolve('/synthetic/native/home')
  const selected = vi.fn(async () => resolve('/synthetic/legacy/home'))
  const prepareResume = vi.fn(() => null)
  const host = { getPtyExecutionHostMetadata: vi.fn(), subscribeToPtyExit: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the real routing registry and home selector use this synthetic host; no terminal is spawned.
  const runtime = host as unknown as OrcaRuntimeService
  installNativeCodexHomeContext(runtime, {
    storageRoot: resolve('/synthetic'),
    homeDirectory: nativeHome,
    resolveSourceHome: () => null,
    assertExclusive: () => {}
  })
  registerNativeCodexRoutingOwner(runtime, 'launch', {
    readOwner: () => null,
    routingKey: 'a'.repeat(64),
    revoke: async () => {},
    dispose: () => {}
  })
  const launch = (
    key = 'a'.repeat(64),
    home = nativeHome,
    agent: 'codex' | 'claude' = 'codex',
    resume = false
  ) =>
    resolvePtySpawnHostEnv({
      launchAgent: agent,
      command: 'codex',
      resumeProviderSession: resume ? { key: 'session_id', id: 'native-resume' } : undefined,
      env: { CODEX_HOME: home, OPKA_CODEX_ROUTING_KEY: key },
      cwd: resolve('/synthetic'),
      shellOverride: undefined,
      expectedWslDistro: null,
      codexSelectionTarget: { runtime: 'host' },
      preAdopted: false,
      isDaemonHostSpawn: true,
      sessionId: undefined,
      callerNamedSession: false,
      mintedSessionId: false,
      resumeOnSelectedAccount: false,
      emptySessionIdSkipsHostEnv: true,
      requestedAgentTeamsPath: undefined,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Selection returns before provider access; this test launches no process.
      provider: {} as never,
      deps: {
        runtime,
        getSettings: () => createGlobalSettingsFixture(),
        getSelectedCodexHomePath: selected,
        prepareCodexResumeHome: prepareResume,
        noCodexResumeLaunch,
        resolveCodexResumeLaunch: async () => noCodexResumeLaunch('codex'),
        reconcileSharedRuntimeResumeHome: async () => {
          throw new Error('Unexpected resume')
        },
        stripSequencedStartupResumeArgv: (env) => env
      }
    })
  return { runtime, nativeHome, selected, prepareResume, launch }
}

it('keeps the host-owned gateway HOME before daemon provider selection', async () => {
  const f = fixture()
  expect((await f.launch()).selectedCodexHomePath).toBe(f.nativeHome)
  expect(f.selected).not.toHaveBeenCalled()
  expect(ensureCodexStateDbBackfillRecoveryStarted).toHaveBeenCalledWith(f.nativeHome)
})

it('does not preserve a forged or revoked routing capability', async () => {
  const f = fixture()
  expect((await f.launch('b'.repeat(64))).selectedCodexHomePath).toBe(
    resolve('/synthetic/legacy/home')
  )
  await revokeNativeCodexRoutingLaunch(f.runtime, 'launch')
  expect((await f.launch()).selectedCodexHomePath).toBe(resolve('/synthetic/legacy/home'))
  expect(f.selected).toHaveBeenCalledTimes(2)
})

it('refuses a live capability paired with a different HOME', async () => {
  const f = fixture()
  await expect(f.launch('a'.repeat(64), resolve('/synthetic/foreign/home'))).rejects.toThrow('HOME')
  expect(f.selected).not.toHaveBeenCalled()
})

it('keeps ordinary other-agent account selection unchanged', async () => {
  const f = fixture()
  expect((await f.launch('a'.repeat(64), f.nativeHome, 'claude')).selectedCodexHomePath).toBe(
    resolve('/synthetic/legacy/home')
  )
  expect(f.selected).toHaveBeenCalledOnce()
})

it('refuses revocation during asynchronous preparation without falling back', async () => {
  const f = fixture()
  vi.mocked(ensureCodexStateDbBackfillRecoveryStarted).mockImplementationOnce(async () => {
    await revokeNativeCodexRoutingLaunch(f.runtime, 'launch')
  })
  await expect(f.launch()).rejects.toThrow('routing')
  expect(f.selected).not.toHaveBeenCalled()
})

it('keeps native resume argv on its own HOME without ordinary resume preparation', async () => {
  const f = fixture()
  expect((await f.launch('a'.repeat(64), f.nativeHome, 'codex', true)).selectedCodexHomePath).toBe(
    f.nativeHome
  )
  expect(f.prepareResume).not.toHaveBeenCalled()
  expect(f.selected).not.toHaveBeenCalled()
})
