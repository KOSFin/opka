import { useState } from 'react'
import { getProviderAccountsOwnerKey } from '@/runtime/runtime-provider-accounts-client'
import { translate } from '@/i18n/i18n'
import { formatRateLimitWindowChipLabel, formatWindowLabel } from '@/lib/window-label-formatter'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import { Button } from '../ui/button'
import { DropdownMenuItem } from '../ui/dropdown-menu'
import { CodexResetCreditControl } from '../codex-reset-credit-control'
import { useUsageAccounts } from './UsageAccountsContext'
import { useUsageAccountPools } from './use-usage-account-pools'
import { UsageAccountPoolLabel } from './UsageAccountPoolLabel'
import { UsageAccountPinButton } from './UsageAccountPinButton'
import { usageAccountRoster } from './usage-account-roster'
import { usageAccountRuntimeKey } from './usage-pinned-account-projection'
import { getWindowSections, ProviderIcon } from './tooltip'

export function UsageAccountRows({
  provider,
  now,
  display,
  mode = 'verbose',
  onManageProvider,
  onSelectAccount,
  selecting = false
}: {
  provider: 'claude' | 'codex'
  now: number
  display: UsagePercentageDisplay
  mode?: StatusBarUsageMode
  onManageProvider?: () => void
  onSelectAccount?: (accountId: string | null) => void
  selecting?: boolean
}): React.JSX.Element | null {
  const owner = useUsageAccounts()
  const pools = useUsageAccountPools()
  const [openRowId, setOpenRowId] = useState<string | null>(null)
  if (!owner) {
    return null
  }
  const snapshot = owner.snapshot
  const rows = snapshot ? usageAccountRoster(provider, snapshot, owner.rateLimits) : null
  const failed = snapshot?.failedProviders?.includes(provider)
  const providerName = provider === 'claude' ? 'Claude' : 'Codex'
  if (!rows?.length) {
    return (
      <div className="flex items-center gap-2 border-b border-border/50 px-3.5 py-2 text-xs">
        <ProviderIcon provider={provider} />
        <span className="font-medium">{providerName}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {failed || !owner.verified
            ? translate('usage.accounts.unavailable', 'Account list unavailable')
            : rows
              ? translate('usage.accounts.empty', 'No accounts on this host')
              : translate('usage.accounts.loading', 'Loading accounts…')}
        </span>
        {onManageProvider ? (
          <Button variant="ghost" size="xs" onClick={onManageProvider}>
            {translate('usage.accounts.manage', 'Manage')}
          </Button>
        ) : null}
      </div>
    )
  }
  return (
    <div data-usage-account-provider={provider} className="border-b border-border/50">
      {rows.map((row) => {
        const windows =
          row.limits?.status === 'ok'
            ? getWindowSections(row.limits).filter((section) => section.window !== null)
            : []
        const shown =
          mode === 'compact'
            ? [...windows]
                .sort((a, b) => (b.window?.usedPercent ?? 0) - (a.window?.usedPercent ?? 0))
                .slice(0, 1)
            : windows
        const rowKey = row.id ?? 'system'
        const open = openRowId === rowKey
        const credits = row.limits?.rateLimitResetCredits?.availableCount ?? 0
        return (
          <div
            key={rowKey}
            role="group"
            aria-label={`${providerName} ${row.label} usage`}
            data-open={open}
            className="group px-3.5 py-2 hover:bg-accent/20"
          >
            <DropdownMenuItem
              asChild
              onSelect={(event) => {
                event.preventDefault()
                setOpenRowId(open ? null : rowKey)
              }}
            >
              <button
                type="button"
                className="flex w-full items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={open}
                onKeyDown={(event) => {
                  if (event.key === 'Tab') {
                    event.stopPropagation()
                  }
                }}
              >
                <span className="mt-0.5 shrink-0">
                  <ProviderIcon provider={provider} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-xs font-medium">
                    {providerName} · {row.label}
                  </span>
                  <span className="text-3xs text-muted-foreground">
                    {row.active
                      ? translate('usage.accounts.default', 'Default for new chats')
                      : translate('usage.accounts.savedProfile', 'Saved profile')}
                    {row.detail ? ` · ${row.detail}` : ''}
                  </span>
                </span>
                {row.limits && now - row.limits.updatedAt > 10 * 60_000 ? (
                  <span className="shrink-0 text-3xs text-muted-foreground">
                    {translate('usage.accounts.staleLimits', 'Last known')}
                  </span>
                ) : null}
              </button>
            </DropdownMenuItem>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-5 text-2xs tabular-nums text-muted-foreground">
              {shown.length ? (
                shown.map(({ label, window }) =>
                  window ? (
                    <span key={label}>
                      {window === row.limits?.session || window === row.limits?.weekly
                        ? formatWindowLabel(window.windowMinutes)
                        : label}
                      {' · '}
                      {getDisplayedUsagePercentage(window.usedPercent, display)}%{' · '}
                      {formatRateLimitWindowChipLabel(window, now)}
                    </span>
                  ) : null
                )
              ) : (
                <span>{translate('usage.accounts.unknownLimits', 'Limits unavailable')}</span>
              )}
            </div>
            <div
              className="hidden space-y-2 pt-2 pl-5 group-hover:block group-focus-within:block group-data-[open=true]:block"
              onKeyDown={(event) => {
                if (event.key === 'Tab') {
                  event.stopPropagation()
                }
              }}
            >
              {!owner.verified ? (
                <p className="text-3xs text-muted-foreground">
                  {translate('usage.accounts.unverified', 'Last known · host not verified')}
                </p>
              ) : null}
              <UsageAccountPoolLabel
                view={pools.view}
                verified={pools.verified}
                provider={provider}
                accountId={row.id}
              />
              <div className="flex items-center gap-2">
                <UsageAccountPinButton
                  pin={{
                    owner: getProviderAccountsOwnerKey(owner.target),
                    provider,
                    runtimeKey: usageAccountRuntimeKey(provider, snapshot, owner.rateLimits),
                    accountId: row.id,
                    label:
                      row.id === null
                        ? translate('accounts.cliLoginOnHost', 'CLI login on this host')
                        : (row.detail ? `${row.label} (${row.detail})` : row.label).slice(0, 160)
                  }}
                />
                {onManageProvider ? (
                  <Button variant="ghost" size="xs" onClick={onManageProvider}>
                    {translate('usage.accounts.manage', 'Manage account')}
                  </Button>
                ) : null}
              </div>
              {provider === 'codex' && snapshot ? (
                <>
                  {!row.active && onSelectAccount ? (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={!owner.verified || selecting}
                      onClick={() => onSelectAccount(row.id)}
                    >
                      {row.id === null
                        ? translate('usage.accounts.useCliLogin', 'Use CLI login')
                        : credits > 0
                          ? 'Select account to use reset'
                          : 'Select account'}
                    </Button>
                  ) : null}
                  {row.id ? (
                    <CodexResetCreditControl
                      account={
                        snapshot.codex.accounts.find((account) => account.id === row.id) ?? null
                      }
                      limits={row.limits}
                      rateLimitTarget={owner.rateLimits.codexTarget}
                      owner={owner.target}
                      ownerLabel={owner.ownerLabel ?? 'This device'}
                      verified={owner.verified}
                      active={row.active}
                    />
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
