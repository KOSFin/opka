import type { HostStackRouteTarget } from '../navigation/host-stack-navigation'
import type { AccountsSnapshot, ProviderKey } from '../components/AccountUsage'
import { getProviderAccountSelection } from '../components/provider-account-usage'

export type MobileAccountsUsageIntent = {
  provider: ProviderKey
  accountId: string | null
  runtimeKey: string
}

export type MobileAccountsUsageRouteParams = {
  usageHostId?: string
  usageProvider?: string
  usageAccountId?: string
  usageRuntimeKey?: string
}

/** Host id stays raw — the navigator owns the params, so pre-encoding one would
 *  reach the accounts screen still escaped. */
export function mobileAccountsRouteTarget(
  hostId: string,
  usage?: MobileAccountsUsageIntent
): HostStackRouteTarget {
  return {
    name: '[hostId]/accounts',
    params: usage
      ? {
          hostId,
          usageHostId: hostId,
          usageProvider: usage.provider,
          usageAccountId: usage.accountId ?? '',
          usageRuntimeKey: usage.runtimeKey
        }
      : { hostId }
  }
}

export function matchingMobileAccountsUsageIntent(
  snapshot: AccountsSnapshot,
  hostId: string,
  params: MobileAccountsUsageRouteParams
): MobileAccountsUsageIntent | null {
  if (
    params.usageHostId !== hostId ||
    (params.usageProvider !== 'claude' && params.usageProvider !== 'codex') ||
    params.usageAccountId === undefined ||
    !params.usageRuntimeKey
  ) {
    return null
  }
  const provider = params.usageProvider
  const accountId = params.usageAccountId || null
  const selection = getProviderAccountSelection(snapshot, provider)
  if (
    selection.runtimeKey !== params.usageRuntimeKey ||
    selection.accountId !== accountId ||
    (accountId !== null && !snapshot[provider].accounts.some((account) => account.id === accountId))
  ) {
    return null
  }
  return { provider, accountId, runtimeKey: selection.runtimeKey }
}
