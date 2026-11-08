import { X } from 'lucide-react'
import { Button } from '../ui/button'
import { useAppStore } from '../../store'
import { useUsageAccounts } from './UsageAccountsContext'
import { getProviderAccountsOwnerKey } from '@/runtime/runtime-provider-accounts-client'
import {
  normalizeStatusBarAccountPins,
  statusBarAccountPinKey
} from '../../../../shared/status-bar-account-pins'
import { translate } from '@/i18n/i18n'
import { usageAccountRoster } from './usage-account-roster'
import { usageAccountRuntimeKey } from './usage-pinned-account-projection'

export function UsagePinnedAccountSettings(): React.JSX.Element | null {
  const source = useUsageAccounts()
  const stored = useAppStore((state) => state.statusBarAccountPins)
  const setPins = useAppStore((state) => state.setStatusBarAccountPins)
  const pins = normalizeStatusBarAccountPins(stored)
  if (!source?.verified || !source.snapshot) {
    return null
  }
  const snapshot = source.snapshot
  const current = pins.filter((pin) => pin.owner === getProviderAccountsOwnerKey(source.target))
  const unavailable = current.filter(
    (pin) =>
      pin.runtimeKey !== usageAccountRuntimeKey(pin.provider, snapshot, source.rateLimits) ||
      !usageAccountRoster(pin.provider, snapshot, source.rateLimits)?.some(
        (row) => row.id === pin.accountId
      )
  )
  if (!unavailable.length) {
    return null
  }
  return (
    <details className="border-t border-border/50 px-3.5 py-2">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {translate('usage.accounts.otherPinned', 'Other pinned accounts')} ({unavailable.length})
      </summary>
      {unavailable.map((pin) => (
        <div
          key={statusBarAccountPinKey(pin)}
          className="flex items-center justify-between gap-2 py-1 text-2xs"
        >
          <span className="min-w-0 truncate">
            {pin.provider} · {pin.label} · {pin.runtimeKey}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={!setPins}
            aria-label={translate(
              'usage.accounts.unpinAccount',
              'Unpin {{account}} from status bar',
              { account: pin.label }
            )}
            onClick={() =>
              setPins(
                pins.filter(
                  (entry) => statusBarAccountPinKey(entry) !== statusBarAccountPinKey(pin)
                )
              )
            }
          >
            <X size={12} />
          </Button>
        </div>
      ))}
    </details>
  )
}
