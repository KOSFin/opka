import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import type { ReactNode } from 'react'
import { useAppStore } from '../../store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { getProviderAccountsOwnerKey } from '@/runtime/runtime-provider-accounts-client'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { getDisplayedUsagePercentage } from '../../../../shared/usage-percentage-display'
import {
  normalizeStatusBarAccountPins,
  statusBarAccountPinKey
} from '../../../../shared/status-bar-account-pins'
import { projectUsagePinnedAccounts } from './usage-pinned-account-projection'
import { ProviderIcon } from './tooltip'
import { getTightestUsageSection } from './UsageRosterPanel'
import { translate } from '@/i18n/i18n'

export function UsagePinnedAccounts({
  target,
  snapshot,
  limits,
  verified,
  display,
  fallback
}: {
  target: RuntimeClientTarget
  snapshot: ProviderAccountsSnapshot | null
  limits: RateLimitState
  verified: boolean
  display: UsagePercentageDisplay
  fallback: ReactNode
}): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const stored = useAppStore((state) => state.statusBarAccountPins)
  const pins = normalizeStatusBarAccountPins(stored)
  const localSnapshot: ProviderAccountsSnapshot | null =
    target.kind === 'local' && settings
      ? {
          claude: {
            accounts: settings.claudeManagedAccounts,
            activeAccountId: settings.activeClaudeManagedAccountId,
            activeAccountIdsByRuntime: settings.activeClaudeManagedAccountIdsByRuntime
          },
          codex: {
            accounts: settings.codexManagedAccounts,
            activeAccountId: settings.activeCodexManagedAccountId,
            activeAccountIdsByRuntime: settings.activeCodexManagedAccountIdsByRuntime
          },
          rateLimits: null
        }
      : null
  const projection = projectUsagePinnedAccounts(
    pins,
    getProviderAccountsOwnerKey(target),
    snapshot ?? localSnapshot,
    limits,
    target.kind === 'local' || verified
  )
  const now = useResetCountdownClock(
    projection.visible.flatMap((entry) =>
      entry.limits
        ? [
            entry.limits.updatedAt + 10 * 60_000,
            entry.limits.session?.resetsAt,
            entry.limits.weekly?.resetsAt
          ]
        : []
    )
  )
  if (!projection.visible.length) {
    return <>{fallback}</>
  }
  return (
    <span className="inline-flex max-w-60 items-center gap-2 overflow-hidden" data-pinned-accounts>
      {projection.visible.map((entry) => {
        const usage = entry.limits?.status === 'ok' ? getTightestUsageSection(entry.limits) : null
        const stale = entry.limits ? now - entry.limits.updatedAt > 10 * 60_000 : false
        const state = !entry.available
          ? translate('usage.accounts.pinnedUnavailable', 'Account unavailable')
          : !usage
            ? translate('usage.accounts.unknownLimits', 'Limits unavailable')
            : stale
              ? translate('usage.accounts.staleLimits', 'Last known limits')
              : usage.label
        return (
          <span
            key={statusBarAccountPinKey(entry.pin)}
            className="inline-flex min-w-0 max-w-20 items-center gap-1"
            title={`${entry.pin.provider} · ${entry.label} · ${entry.pin.runtimeKey} · ${state}`}
            aria-label={`${entry.pin.provider} · ${entry.label} · ${state}`}
          >
            <ProviderIcon provider={entry.pin.provider} />
            <span className="min-w-0 truncate text-2xs">{entry.label.split('@')[0]}</span>
            <span className="text-2xs tabular-nums">
              {usage
                ? `${stale ? '~' : ''}${getDisplayedUsagePercentage(usage.window.usedPercent, display)}%`
                : '—'}
            </span>
          </span>
        )
      })}
      {projection.overflow ? (
        <span className="shrink-0 text-2xs text-muted-foreground">+{projection.overflow}</span>
      ) : null}
    </span>
  )
}
