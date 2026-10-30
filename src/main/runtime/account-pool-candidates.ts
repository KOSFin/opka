import type { AccountPoolCandidate } from '../../shared/account-pool-policy'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { AccountsSnapshot } from './runtime-account-controller'

function quotaState(
  usage: ProviderRateLimits | null | undefined
): Pick<AccountPoolCandidate, 'quota' | 'usedPercent'> {
  if (!usage || usage.status !== 'ok' || Date.now() - usage.updatedAt > 10 * 60_000) {
    return { quota: 'unknown', usedPercent: null }
  }
  const windows = [usage.session, usage.weekly, ...(usage.buckets ?? [])].filter(
    (window) => window !== null
  )
  if (!windows.length) {
    return { quota: 'unknown', usedPercent: null }
  }
  const usedPercent = Math.max(...windows.map((window) => window.usedPercent))
  return { quota: usedPercent >= 100 ? 'exhausted' : 'available', usedPercent }
}
export function accountPoolCandidates(snapshot: AccountsSnapshot) {
  return [
    ...snapshot.claude.accounts.map((account) => ({
      provider: 'claude' as const,
      accountId: account.id,
      quotaIdentity: account.organizationUuid
        ? `org:${account.organizationUuid}:${account.email}`
        : account.email,
      auth:
        account.needsSignIn ||
        account.runsOnSystemDefault ||
        account.authMethod === 'unknown' ||
        account.managedAuthRuntime === 'wsl'
          ? ('unavailable' as const)
          : ('ready' as const),
      ...quotaState(
        account.id === snapshot.claude.activeAccountId
          ? snapshot.rateLimits.claude
          : snapshot.rateLimits.inactiveClaudeAccounts.find(
              (entry) => entry.accountId === account.id
            )?.rateLimits
      )
    })),
    ...snapshot.codex.accounts.map((account) => ({
      provider: 'codex' as const,
      accountId: account.id,
      quotaIdentity: account.providerAccountId ?? account.email,
      auth:
        account.managedHomeRuntime === 'wsl' || !account.lastAuthenticatedAt
          ? ('unavailable' as const)
          : ('ready' as const),
      ...quotaState(
        account.id === snapshot.codex.activeAccountId
          ? snapshot.rateLimits.codex
          : snapshot.rateLimits.inactiveCodexAccounts.find(
              (entry) => entry.accountId === account.id
            )?.rateLimits
      )
    }))
  ]
}
