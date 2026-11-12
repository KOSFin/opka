import { addViewportSizeChangeListener } from '@/hooks/viewport-size-change-listener'
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
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { CodexResetCreditControl } from '../codex-reset-credit-control'
import { useUsageAccounts } from './UsageAccountsContext'
import { useUsageAccountPools } from './use-usage-account-pools'
import { UsageAccountPoolLabel } from './UsageAccountPoolLabel'
import { UsageAccountPinButton } from './UsageAccountPinButton'
import { usageAccountRoster } from './usage-account-roster'
import { usageAccountRuntimeKey } from './usage-pinned-account-projection'
import { getWindowSections, ProviderIcon, ProviderPanel } from './tooltip'

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
  const selectedTriggerRef = useRef<HTMLButtonElement>(null)
  const detailsAnchorRef = useRef({
    getBoundingClientRect: () => {
      const trigger = selectedTriggerRef.current
      const row = trigger?.getBoundingClientRect()
      const menu = trigger?.closest('[data-slot="popover-content"]')?.getBoundingClientRect()
      if (!row) {
        return new DOMRect()
      }
      if (menu && menu.right + 336 > window.innerWidth) {
        return menu
      }
      return menu ? new DOMRect(menu.x, row.y, menu.width, row.height) : row
    }
  })
  const pendingFocusRowId = useRef<string | null>(null)
  const [detailsSide, setDetailsSide] = useState<'right' | 'top'>('right')
  useLayoutEffect(() => {
    if (!openRowId) {
      return
    }
    const updateSide = () => {
      const menu = selectedTriggerRef.current
        ?.closest('[data-slot="popover-content"]')
        ?.getBoundingClientRect()
      setDetailsSide(menu && menu.right + 336 > window.innerWidth ? 'top' : 'right')
    }
    updateSide()
    return addViewportSizeChangeListener(updateSide)
  }, [openRowId])
  useLayoutEffect(() => {
    if (pendingFocusRowId.current === openRowId) {
      const firstAction = detailRef.current?.querySelector('button')
      if (firstAction) {
        pendingFocusRowId.current = null
        firstAction.focus()
      }
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
    <Popover
      open={selected !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          inspectRow('')
        }
      }}
    >
      <PopoverAnchor virtualRef={detailsAnchorRef} />
      <div data-usage-account-provider={provider} className="border-b border-border/50">
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
            const rowNode = (
              <div
                key={rowKey}
                role="group"
                aria-label={`${providerName} ${row.label} usage`}
                data-open={open}
                className="group px-3.5 py-2 hover:bg-accent"
              >
                <button
                  type="button"
                  ref={open ? selectedTriggerRef : undefined}
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
            return rowNode
          })}
        </div>
        {selected ? (
          <PopoverContent
            role="region"
            side={detailsSide}
            align="start"
            sideOffset={8}
            collisionPadding={8}
            className="w-[320px] max-w-[calc(100vw-2rem)] max-h-[min(28rem,80vh,var(--radix-popover-content-available-height))] overflow-y-auto"
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              if (pendingFocusRowId.current === openRowId) {
                pendingFocusRowId.current = null
                detailRef.current?.querySelector('button')?.focus()
              }
            }}
            onInteractOutside={(event) => {
              const target = event.target
              if (target instanceof Element && target.closest('[data-usage-account-provider]')) {
                event.preventDefault()
              }
            }}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => {
              if (owner.dismiss) {
                event.preventDefault()
                owner.dismiss()
              } else {
                selectedTriggerRef.current?.focus()
              }
            }}
          >
            <aside
              ref={detailRef}
              aria-label={`${providerName} ${selected.label} details`}
              className="space-y-3 p-3"
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
              <ProviderPanel
                p={selected.limits}
                showResetCredits={false}
                usagePercentageDisplay={display}
              />
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
                        snapshot.codex.accounts.find((account) => account.id === selected.id) ??
                        null
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
          </PopoverContent>
        ) : null}
      </div>
    </Popover>
  )
}
