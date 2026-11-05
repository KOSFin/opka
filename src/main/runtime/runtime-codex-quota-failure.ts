import { codexAccountQuotaIdentity } from '../../shared/account-pool-policy'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { usageAccountProvenance } from '../../shared/usage-account-provenance'
import { getSelectedCodexAccountIdForTarget } from '../codex-accounts/runtime-selection'
import type { CodexHostQuotaFailure } from '../codex-routing/codex-host-quota-retry'
import type {
  CodexProviderFailureEvent,
  CodexProviderFailureAccountResolver
} from '../rate-limits/codex-provider-failure'

export type NativeCodexQuotaSettings = Pick<
  GlobalSettings,
  'codexManagedAccounts' | 'activeCodexManagedAccountId' | 'activeCodexManagedAccountIdsByRuntime'
>
export type NativeCodexQuotaAuthority = {
  ingestCodexProviderFailure(
    event: CodexProviderFailureEvent,
    resolver: CodexProviderFailureAccountResolver
  ): boolean
}

/** The retained resolver reads roster metadata only; quota state reads must not recurse. */
export function createRuntimeCodexQuotaFailureRecorder(options: {
  getSettings: () => NativeCodexQuotaSettings
  readConnection: (id: string) => { providerAccountId: string } | null
  rateLimits: NativeCodexQuotaAuthority
}) {
  const resolve: CodexProviderFailureAccountResolver = (id) => {
    const settings = options.getSettings()
    const account = settings.codexManagedAccounts?.find((entry) => entry.id === id)
    if (!account?.providerAccountId || account.managedHomeRuntime === 'wsl') {
      return null
    }
    return {
      quotaIdentity: codexAccountQuotaIdentity(account),
      authProvenance: usageAccountProvenance('host', id),
      identityVerified: true,
      selected: getSelectedCodexAccountIdForTarget(settings, { runtime: 'host' }) === id
    }
  }
  return (event: CodexHostQuotaFailure): boolean => {
    const proof = resolve(event.accountId)
    const connection = options.readConnection(event.accountId)
    if (
      !proof ||
      proof.quotaIdentity !== event.quotaIdentity ||
      connection?.providerAccountId !== event.quotaIdentity
    ) {
      return false
    }
    return options.rateLimits.ingestCodexProviderFailure(
      {
        ...event,
        authProvenance: proof.authProvenance,
        observedAt: Date.now()
      },
      resolve
    )
  }
}
