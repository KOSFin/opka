import { useLayoutEffect, useRef, useState } from 'react'
import { getProviderAccountsOwnerKey } from '@/runtime/runtime-provider-accounts-client'
import { translate } from '@/i18n/i18n'
import { formatRateLimitWindowChipLabel, formatWindowLabel } from '@/lib/window-label-formatter'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import { Button } from '../ui/button'
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
  selecting = false,
  inspectedRowId,
  onInspectRow
}: {
  provider: 'claude' | 'codex'
  now: number
  display: UsagePercentageDisplay
  mode?: StatusBarUsageMode
  onManageProvider?: () => void
  onSelectAccount?: (accountId: string | null) => void
  selecting?: boolean
  inspectedRowId?: string | null
  onInspectRow?: (rowId: string) => void
}): React.JSX.Element | null {
  const owner = useUsageAccounts()
  const pools = useUsageAccountPools()
  const [localOpenRowId, setLocalOpenRowId] = useState<string | null>(null)
  const openRowId = onInspectRow ? inspectedRowId : localOpenRowId
  const inspectRow = onInspectRow ?? setLocalOpenRowId
  const detailRef = useRef<HTMLElement>(null)
  const pendingFocusRowId = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (pendingFocusRowId.current === openRowId) {
      pendingFocusRowId.current = null
      detailRef.current?.querySelector('button')?.focus()
    }
  })
  if (!owner) {
    return null
  }
  const snapshot = owner.snapshot
  const rows = snapshot ? usageAccountRoster(provider, snapshot, owner.rateLimits) : null
  const failed = snapshot?.failedProviders?.includes(provider)
  const providerName = provider === 'claude' ? 'Claude' : 'Codex'
  if (!snapshot || !rows?.length) {
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
  const selected = rows.find((row) => (row.id ?? 'system') === openRowId)
  const credits = selected?.limits?.rateLimitResetCredits?.availableCount ?? 0
  return (
    <div
      data-usage-account-provider={provider}
      className="grid grid-cols-[minmax(0,360px)_minmax(0,1fr)] border-b border-border/50 max-[760px]:grid-cols-1"
    >
      <div>
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
          return (
            <div
              key={rowKey}
              role="group"
              aria-label={`${providerName} ${row.label} usage`}
              data-open={open}
              className="group px-3.5 py-2 hover:bg-accent"
            >
              <button
                type="button"
                className="flex w-full items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={open}
                onClick={() => inspectRow(rowKey)}
                onMouseEnter={() => inspectRow(rowKey)}
                onFocus={() => inspectRow(rowKey)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    pendingFocusRowId.current = rowKey
                    inspectRow(rowKey)
                    if (open) {
                      pendingFocusRowId.current = null
                      detailRef.current?.querySelector('button')?.focus()
                    }
                  }
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
                  {row.active || row.id !== null ? (
                    <span className="text-3xs text-muted-foreground">
                      {row.active
                        ? translate('usage.accounts.default', 'Default for new chats')
                        : translate('usage.accounts.savedProfile', 'Saved profile')}
                      {row.detail ? ` · ${row.detail}` : ''}
                    </span>
                  ) : null}
                </span>
                {row.limits && now - row.limits.updatedAt > 10 * 60_000 ? (
                  <span className="shrink-0 text-3xs text-muted-foreground">
                    {translate('usage.accounts.staleLimits', 'Last known')}
                  </span>
                ) : null}
              </button>
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
            </div>
          )
        })}
      </div>
      {selected ? (
        <aside
          ref={detailRef}
          aria-label={`${providerName} ${selected.label} details`}
          className="space-y-2 border-l border-border/50 px-3.5 py-3 max-[760px]:border-t max-[760px]:border-l-0"
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              event.stopPropagation()
            }
          }}
        >
          <p className="break-words text-xs font-semibold">
            {providerName} · {selected.label}
          </p>
          {!owner.verified ? (
            <p className="text-3xs text-muted-foreground">
              {translate('usage.accounts.unverified', 'Last known · host not verified')}
            </p>
          ) : null}
          <UsageAccountPoolLabel
            view={pools.view}
            verified={pools.verified}
            provider={provider}
            accountId={selected.id}
          />
          <div className="flex items-center gap-2">
            <UsageAccountPinButton
              pin={{
                owner: getProviderAccountsOwnerKey(owner.target),
                provider,
                runtimeKey: usageAccountRuntimeKey(provider, snapshot, owner.rateLimits),
                accountId: selected.id,
                label:
                  selected.id === null
                    ? translate('accounts.cliLoginOnHost', 'CLI login on this host')
                    : (selected.detail
                        ? `${selected.label} (${selected.detail})`
                        : selected.label
                      ).slice(0, 160)
              }}
            />
            {onManageProvider ? (
              <Button variant="ghost" size="xs" onClick={onManageProvider}>
                {translate('usage.accounts.manage', 'Manage account')}
              </Button>
            ) : null}
          </div>
          {provider === 'codex' ? (
            <>
              {!selected.active && onSelectAccount ? (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={!owner.verified || selecting}
                  onClick={() => onSelectAccount(selected.id)}
                >
                  {selected.id === null
                    ? translate('usage.accounts.useCliLogin', 'Use CLI login')
                    : credits > 0
                      ? 'Select account to use reset'
                      : 'Select account'}
                </Button>
              ) : null}
              {selected.id ? (
                <CodexResetCreditControl
                  account={
                    snapshot.codex.accounts.find((account) => account.id === selected.id) ?? null
                  }
                  limits={selected.limits}
                  rateLimitTarget={owner.rateLimits.codexTarget}
                  owner={owner.target}
                  ownerLabel={owner.ownerLabel ?? 'This device'}
                  verified={owner.verified}
                  active={selected.active}
                />
              ) : null}
            </>
          ) : null}
        </aside>
      ) : (
        <div className="flex items-center border-l border-border/50 px-3.5 py-3 text-xs text-muted-foreground max-[760px]:hidden">
          {translate('usage.accounts.inspect', 'Hover or focus an account for details')}
        </div>
      )}
    </div>
  )
}
