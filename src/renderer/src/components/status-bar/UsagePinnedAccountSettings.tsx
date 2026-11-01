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

export function UsagePinnedAccountSettings(): React.JSX.Element | null {
  const source = useUsageAccounts()
  const stored = useAppStore((state) => state.statusBarAccountPins)
  const setPins = useAppStore((state) => state.setStatusBarAccountPins)
  const pins = normalizeStatusBarAccountPins(stored)
  const current = source
    ? pins.filter((pin) => pin.owner === getProviderAccountsOwnerKey(source.target))
    : []
  if (!current.length) {
    return null
  }
  return (
    <details className="border-t border-border/50 px-3.5 py-2">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {translate('usage.accounts.pinnedTitle', 'Pinned status bar accounts')} ({current.length})
      </summary>
      <p className="py-2 text-2xs text-muted-foreground">
        {translate(
          'usage.accounts.pinExplanation',
          'Up to three accounts appear for this host. Unpin all to restore the provider summary. Pins only change this display.'
        )}
      </p>
      {current.map((pin) => (
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
