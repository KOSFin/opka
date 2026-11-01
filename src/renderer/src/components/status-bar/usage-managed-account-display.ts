import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import {
  getCodexAccountDisplayDetail,
  getCodexAccountDisplayLabel
} from '@/lib/codex-account-display-label'

export function usageManagedAccountDisplay(
  provider: 'claude' | 'codex',
  snapshot: ProviderAccountsSnapshot,
  accountId: string
): { email: string; label: string; detail: string | null } | null {
  const accounts =
    provider === 'codex'
      ? snapshot.codex.accounts
      : snapshot.claude.accounts.map((account) => ({
          id: account.id,
          email: account.email,
          workspaceLabel: account.organizationName
        }))
  const account = accounts.find((entry) => entry.id === accountId)
  return account
    ? {
        email: account.email,
        label: getCodexAccountDisplayLabel(account, accounts),
        detail: getCodexAccountDisplayDetail(account, accounts)
      }
    : null
}
