import {
  nativeCodexHomeContext,
  installNativeCodexHomeContext,
  assertNativeCodexPreferenceHomeUnused
} from './native-codex-home-context'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { captureNativeAccountProfileOwnership } from './native-account-profile-ownership'
import { assertEngineWriterIdle } from '../codex-routing/engine-writer-ownership'
import {
  installRuntimeCodexEngineHost,
  peekRuntimeCodexEngineHost
} from './runtime-codex-engine-host'
import {
  createRuntimeCodexQuotaFailureRecorder,
  type NativeCodexQuotaAuthority,
  type NativeCodexQuotaSettings
} from './runtime-codex-quota-failure'

type Runtime = Parameters<typeof installRuntimeCodexEngineHost>[0]
type AccountService = Parameters<typeof installRuntimeCodexEngineHost>[1]['codexAccounts']

/** Binds lazy routing to the profile's existing host lock and account mutation authority. */
export function configureNativeCodexRouting(
  runtime: Runtime,
  options: {
    store: {
      getProfileStorageDirectory(): string
      getSettings(): Pick<GlobalSettings, 'httpProxyUrl' | 'httpProxyBypassRules'> &
        NativeCodexQuotaSettings
    }
    dataRoot: string
    resolveSourceHome?: () => string | null
    codexAccounts: AccountService
    rateLimits: NativeCodexQuotaAuthority
    registerCleanup?: (cleanup: () => Promise<void>) => void
  }
): void {
  const profile = options.store.getProfileStorageDirectory()
  const assertExclusiveProfile = captureNativeAccountProfileOwnership(options.dataRoot)
  const home = nativeCodexHomeContext({
    storageRoot: profile,
    resolveSourceHome: options.resolveSourceHome,
    assertExclusive: assertExclusiveProfile
  })
  installNativeCodexHomeContext(runtime, home)
  const settings = options.store.getSettings()
  installRuntimeCodexEngineHost(runtime, {
    userDataPath: profile,
    assertPreferenceHomeUnused: (path) => assertNativeCodexPreferenceHomeUnused(home, path),
    codexAccounts: options.codexAccounts,
    registerCleanup: options.registerCleanup,
    memoryMiB: 128,
    maxRequestBytes: 4 * 1024 * 1024,
    networkProxySettings: {
      httpProxyUrl: settings.httpProxyUrl,
      httpProxyBypassRules: settings.httpProxyBypassRules
    },
    assertExclusiveProfile,
    recordQuotaFailure: createRuntimeCodexQuotaFailureRecorder({
      getSettings: () => options.store.getSettings(),
      readConnection: (id) => peekRuntimeCodexEngineHost(runtime)?.readConnection(id) ?? null,
      rateLimits: options.rateLimits
    }),
    assertEnrollmentIdle: (accountId) => {
      assertExclusiveProfile()
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(accountId)) {
        throw new Error('A registered routing account is required.')
      }
      assertEngineWriterIdle({
        directory: join(profile, 'codex-routing', 'staging', accountId, 'runtime'),
        assertExclusive: assertExclusiveProfile
      })
    }
  })
}
