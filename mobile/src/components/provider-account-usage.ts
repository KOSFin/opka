import {
  inactiveUsageMatchesAccount,
  usageMatchesAccount
} from '../../../src/shared/usage-account-provenance'
import {
  getActiveProviderRateLimits,
  getInactiveProviderUsage,
  type AccountsSnapshot,
  type ProviderKey
} from './account-usage-state'

export function getProviderAccountSelection(snapshot: AccountsSnapshot, provider: ProviderKey) {
  const target =
    provider === 'codex' ? snapshot.rateLimits.codexTarget : snapshot.rateLimits.claudeTarget
  const accounts = snapshot[provider]
  const runtimeKey =
    target.runtime === 'host' ? 'host' : target.wslDistro ? `wsl:${target.wslDistro}` : null
  const selection = accounts.activeAccountIdsByRuntime
  const accountId = !selection
    ? accounts.activeAccountId
    : target.runtime === 'host'
      ? selection.host
      : target.wslDistro
        ? (selection.wsl[target.wslDistro] ?? null)
        : null
  return { runtimeKey, accountId }
}

export function getAccountProviderUsage(
  snapshot: AccountsSnapshot,
  provider: ProviderKey,
  accountId: string | null
) {
  const selection = getProviderAccountSelection(snapshot, provider)
  const usage = getActiveProviderRateLimits(snapshot, provider)
  if (
    selection.accountId === accountId &&
    selection.runtimeKey &&
    usageMatchesAccount(usage, selection.runtimeKey, accountId)
  ) {
    return usage
  }
  const inactive = accountId
    ? getInactiveProviderUsage(snapshot, provider, accountId)?.rateLimits
    : null
  return accountId &&
    selection.runtimeKey &&
    inactiveUsageMatchesAccount(inactive, selection.runtimeKey, accountId)
    ? (inactive ?? null)
    : null
}
