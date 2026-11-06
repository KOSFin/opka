import type { ReactNode } from 'react'
import type { AccountsSnapshot, ProviderKey } from '../components/AccountUsage'
import { getProviderAccountSelection } from '../components/provider-account-usage'
import type { AccountPoolPolicy } from '../../../src/shared/account-pool-policy'
import { accountPoolDrafts, type AccountPoolView } from '../../../src/shared/account-pool-view'

export type MobileAccountPresentation = {
  renderAccount?: (
    provider: ProviderKey,
    accountId: string,
    manualSelectionBlocked: boolean
  ) => ReactNode
  renderSystemAccount?: (provider: ProviderKey, manualSelectionBlocked: boolean) => ReactNode
  renderProviderFooter?: (provider: ProviderKey) => ReactNode
  renderUnavailableAccounts?: (manualSelectionBlocked: boolean) => ReactNode
}

export function accountPoolSnapshotRefreshKey(
  snapshot: AccountsSnapshot,
  enrollmentRevision: number
) {
  return JSON.stringify([
    enrollmentRevision,
    ...(['claude', 'codex'] as const).map((provider) => [
      getProviderAccountSelection(snapshot, provider),
      snapshot[provider].accounts.map((account) => account.id),
      snapshot.rateLimits[provider]?.updatedAt,
      snapshot.rateLimits[provider]?.status,
      (provider === 'codex'
        ? snapshot.rateLimits.inactiveCodexAccounts
        : snapshot.rateLimits.inactiveClaudeAccounts
      ).map((entry) => [entry.accountId, entry.updatedAt, entry.isFetching])
    ])
  ])
}

export function mergeMobileAccountPoolDrafts(
  view: AccountPoolView,
  previous: AccountPoolPolicy[],
  dirty: ReadonlySet<string>
) {
  return accountPoolDrafts({
    ...view,
    policies: accountPoolDrafts(view).map((policy) =>
      dirty.has(policy.id)
        ? (previous.find((entry) => entry.id === policy.id && entry.provider === policy.provider) ??
          policy)
        : policy
    )
  })
}
