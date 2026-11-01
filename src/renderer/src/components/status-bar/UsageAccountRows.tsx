import { getProviderAccountsOwnerKey } from '@/runtime/runtime-provider-accounts-client'
import { usageAccountRuntimeKey } from './usage-pinned-account-projection'
import { UsageAccountPinButton } from './UsageAccountPinButton'
import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { getDisplayedUsagePercentage } from '../../../../shared/usage-percentage-display'
import { formatWindowLabel, formatRateLimitWindowChipLabel } from '@/lib/window-label-formatter'
import { useUsageAccounts } from './UsageAccountsContext'
import { useUsageAccountPools } from './use-usage-account-pools'
import { UsageAccountPoolLabel } from './UsageAccountPoolLabel'
import { usageAccountRoster } from './usage-account-roster'

export function UsageAccountRows({
  provider,
  now,
  display
}: {
  provider: 'claude' | 'codex'
  now: number
  display: UsagePercentageDisplay
}): React.JSX.Element | null {
  const owner = useUsageAccounts()
  const pools = useUsageAccountPools()
  const [expanded, setExpanded] = useState(true)
  if (!owner) {
    return null
  }
  const snapshot = owner.snapshot
  const rows = snapshot ? usageAccountRoster(provider, snapshot, owner.rateLimits) : null
  const failed = snapshot?.failedProviders?.includes(provider)
  return (
    <div className="border-t border-border/50 px-3.5 py-1.5">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {translate('usage.accounts.title', 'Accounts')}
        {rows ? ` (${rows.length})` : ''}
      </Button>
      {expanded ? (
        <div className="max-h-64 space-y-2 overflow-y-auto py-1 scrollbar-sleek">
          {!rows ? (
            <p className="text-2xs text-muted-foreground">
              {failed || !owner.verified
                ? translate('usage.accounts.unavailable', 'Account list unavailable')
                : translate('usage.accounts.loading', 'Loading accounts…')}
            </p>
          ) : null}
          {rows?.map((row) => (
            <div key={row.id ?? 'system'} className="space-y-1 py-1">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 break-words text-xs">{row.label}</span>
                <UsageAccountPinButton
                  pin={{
                    owner: getProviderAccountsOwnerKey(owner.target),
                    provider,
                    runtimeKey: snapshot
                      ? usageAccountRuntimeKey(provider, snapshot, owner.rateLimits)
                      : 'host',
                    accountId: row.id,
                    label:
                      row.id === null
                        ? translate('accounts.cliLoginOnHost', 'CLI login on this host')
                        : (row.detail ? `${row.label} (${row.detail})` : row.label).slice(0, 160)
                  }}
                />
                {row.active ? (
                  <span className="shrink-0 text-3xs text-muted-foreground">
                    {translate('usage.accounts.default', 'Default for new chats')}
                  </span>
                ) : null}
              </div>
              <p className="text-3xs text-muted-foreground">
                {row.id === null
                  ? translate('usage.accounts.cliSource', 'CLI login source')
                  : translate('usage.accounts.savedProfile', 'Saved profile')}
                {row.detail ? ` · ${row.detail}` : ''}
              </p>
              <UsageAccountPoolLabel
                view={pools.view}
                verified={pools.verified}
                provider={provider}
                accountId={row.id}
              />
              {row.limits && now - row.limits.updatedAt > 10 * 60_000 ? (
                <p className="text-3xs text-muted-foreground">
                  {translate('usage.accounts.staleLimits', 'Last known limits')}
                </p>
              ) : null}
              {!owner.verified ? (
                <p className="text-3xs text-muted-foreground">
                  {translate('usage.accounts.unverified', 'Last known · host not verified')}
                </p>
              ) : null}
              {row.limits?.status === 'ok' && (row.limits.session || row.limits.weekly) ? (
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs tabular-nums text-muted-foreground">
                  {[
                    { key: 'session', window: row.limits.session },
                    { key: 'weekly', window: row.limits.weekly }
                  ].map(({ window, key }) =>
                    window ? (
                      <span key={key}>
                        {formatWindowLabel(window.windowMinutes)} ·{' '}
                        {getDisplayedUsagePercentage(window.usedPercent, display)}% ·{' '}
                        {formatRateLimitWindowChipLabel(window, now)}
                      </span>
                    ) : null
                  )}
                </div>
              ) : (
                <p className="text-2xs text-muted-foreground">
                  {translate('usage.accounts.unknownLimits', 'Limits unavailable')}
                </p>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
