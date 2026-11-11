import {
  usageMatchesAccount,
  inactiveUsageMatchesAccount
} from '../../shared/usage-account-provenance'
import {
  codexAccountQuotaIdentity,
  type AccountPoolCandidate
} from '../../shared/account-pool-policy'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { AccountsSnapshot } from './runtime-account-controller'

function quotaState(
  usage: ProviderRateLimits | null | undefined
): Pick<AccountPoolCandidate, 'quota' | 'usedPercent' | 'quotaWindows' | 'quotaReason'> {
  if (!usage) {
    return { quota: 'unknown', usedPercent: null, quotaReason: 'missing' }
  }
  if (
    usage.status !== 'ok' ||
    !Number.isSafeInteger(usage.updatedAt) ||
    usage.updatedAt > Date.now() + 1000 ||
    Date.now() - usage.updatedAt > 10 * 60_000
  ) {
    return { quota: 'unknown', usedPercent: null, quotaReason: 'stale' }
  }
  const windows = [usage.session, usage.weekly, ...(usage.buckets ?? [])].filter(
    (window) => window !== null
  )
  if (!windows.length) {
    return { quota: 'unknown', usedPercent: null, quotaReason: 'missing' }
  }
  if (
    windows.some(
      (window) =>
        !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100
    )
  ) {
    return { quota: 'unknown', usedPercent: null, quotaReason: 'invalid' }
  }
  const usedPercent = Math.max(...windows.map((window) => window.usedPercent))
  return {
    quota: usedPercent >= 100 ? 'exhausted' : 'available',
    usedPercent,
    quotaWindows: windows.map(
      ({
        windowMinutes,
        verifiedDurationMinutes,
        usedPercent,
        resetsAt,
        resetMetadataInvalid
      }) => ({
        windowMinutes,
        verifiedDurationMinutes,
        usedPercent,
        resetsAt,
        resetMetadataInvalid
      })
    )
  }
}
function accountQuota(snapshot: AccountsSnapshot, provider: 'claude' | 'codex', accountId: string) {
  const active = snapshot.rateLimits[provider]
  if (
    accountId === snapshot[provider].activeAccountId &&
    usageMatchesAccount(active, 'host', accountId)
  ) {
    return quotaState(active)
  }
  const samples =
    provider === 'codex'
      ? snapshot.rateLimits.inactiveCodexAccounts
      : snapshot.rateLimits.inactiveClaudeAccounts
  const inactive = samples.find((entry) => entry.accountId === accountId)?.rateLimits
  return inactiveUsageMatchesAccount(inactive, 'host', accountId)
    ? quotaState(inactive)
    : { quota: 'unknown' as const, usedPercent: null, quotaReason: 'unverified-owner' as const }
}

function confirmedCodexQuota(snapshot: AccountsSnapshot, quotaIdentity: string): boolean {
  const accounts = snapshot.codex.accounts.filter(
    (account) => account.providerAccountId && codexAccountQuotaIdentity(account) === quotaIdentity
  )
  const samples = [
    snapshot.rateLimits.codex,
    ...snapshot.rateLimits.inactiveCodexAccounts.map((entry) => entry.rateLimits)
  ].filter(
    (sample) =>
      sample?.provider === 'codex' &&
      accounts.some((account) => usageMatchesAccount(sample, 'host', account.id))
  )
  const now = Date.now()
  const latestFailure = Math.max(
    0,
    ...samples.map((sample) => {
      const failure = sample?.usageMetadata?.confirmedProviderFailure
      if (
        !failure ||
        failure.kind !== 'quota-exhausted' ||
        failure.code !== 'usage_limit_reached' ||
        failure.quotaIdentity !== quotaIdentity ||
        !Number.isSafeInteger(failure.observedAt) ||
        failure.observedAt <= 0 ||
        failure.observedAt > now + 1000 ||
        (failure.resetsAt !== undefined &&
          (!Number.isSafeInteger(failure.resetsAt) ||
            failure.resetsAt <= now ||
            failure.resetsAt - failure.observedAt > 31 * 24 * 60 * 60_000))
      ) {
        return 0
      }
      return failure.observedAt
    })
  )
  return (
    latestFailure > 0 &&
    !samples.some(
      (sample) =>
        sample && sample.updatedAt > latestFailure && quotaState(sample).quota === 'available'
    )
  )
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
      ...accountQuota(snapshot, 'claude', account.id)
    })),
    ...snapshot.codex.accounts.map((account) => ({
      provider: 'codex' as const,
      accountId: account.id,
      quotaIdentity: codexAccountQuotaIdentity(account),
      auth:
        account.managedHomeRuntime === 'wsl' || !account.lastAuthenticatedAt
          ? ('unavailable' as const)
          : ('ready' as const),
      ...(confirmedCodexQuota(snapshot, codexAccountQuotaIdentity(account))
        ? {
            quota: 'exhausted' as const,
            usedPercent: accountQuota(snapshot, 'codex', account.id).usedPercent
          }
        : accountQuota(snapshot, 'codex', account.id))
    }))
  ]
}
