import { translate } from '@/i18n/i18n'
import { usageManagedAccountDisplay } from './usage-managed-account-display'
import {
  usageMatchesAccount,
  inactiveUsageMatchesAccount
} from '../../../../shared/usage-account-provenance'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import {
  buildClaudeStatusSwitchGroups,
  normalizeClaudeStatusRuntimeTarget
} from './status-bar-claude-accounts'
import {
  buildCodexStatusSwitchGroups,
  normalizeCodexStatusRuntimeTarget
} from './status-bar-codex-accounts'
import { getCodexStatusRuntimeKey, toCodexStatusRuntimeTarget } from './status-bar-runtime-targets'

export type UsageAccount = {
  id: string | null
  label: string
  detail: string | null
  active: boolean
  limits: ProviderRateLimits | null
}

export function usageAccountRoster(
  provider: 'claude' | 'codex',
  snapshot: ProviderAccountsSnapshot,
  rateLimits: RateLimitState
): UsageAccount[] | null {
  if (snapshot.failedProviders?.includes(provider)) {
    return null
  }
  const selected = toCodexStatusRuntimeTarget(
    provider === 'codex' ? rateLimits.codexTarget : rateLimits.claudeTarget
  )
  const target =
    provider === 'codex'
      ? normalizeCodexStatusRuntimeTarget(snapshot.codex, selected)
      : normalizeClaudeStatusRuntimeTarget(snapshot.claude, selected)
  const groups =
    provider === 'codex'
      ? buildCodexStatusSwitchGroups(snapshot.codex, target)
      : buildClaudeStatusSwitchGroups(snapshot.claude, target)
  const group = groups.find((entry) => entry.key === getCodexStatusRuntimeKey(target))
  const inactive =
    provider === 'codex' ? rateLimits.inactiveCodexAccounts : rateLimits.inactiveClaudeAccounts
  const systemEmail =
    target.runtime === 'host'
      ? provider === 'codex'
        ? snapshot.codex.systemDefault?.email
        : snapshot.claude.systemDefaultEmail
      : null
  return (group?.targets ?? [])
    .filter((account) => account.id !== null || account.active || Boolean(systemEmail))
    .map((account) => {
      const inactiveLimits = account.id
        ? inactive.find((entry) => entry.accountId === account.id)?.rateLimits
        : null
      const saved = account.id ? usageManagedAccountDisplay(provider, snapshot, account.id) : null
      const cliLabel = translate('accounts.cliLoginOnHost', 'CLI login on this host')
      return {
        id: account.id,
        label:
          account.id === null
            ? systemEmail
              ? `${cliLabel} · ${systemEmail}`
              : cliLabel
            : (saved?.email ?? account.label),
        detail: saved?.detail ?? null,
        active: account.active,
        limits:
          account.active && usageMatchesAccount(rateLimits[provider], group?.key ?? '', account.id)
            ? rateLimits[provider]
            : account.id &&
                inactiveUsageMatchesAccount(inactiveLimits, group?.key ?? '', account.id)
              ? (inactiveLimits ?? null)
              : null
      }
    })
}
