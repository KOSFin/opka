import { Pin, PinOff } from 'lucide-react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import type { StatusBarAccountPin } from '../../../../shared/status-bar-account-pins'
import {
  MAX_STATUS_BAR_ACCOUNT_PINS,
  normalizeStatusBarAccountPins,
  statusBarAccountPinKey
} from '../../../../shared/status-bar-account-pins'

export function UsageAccountPinButton({ pin }: { pin: StatusBarAccountPin }): React.JSX.Element {
  const stored = useAppStore((state) => state.statusBarAccountPins)
  const setPins = useAppStore((state) => state.setStatusBarAccountPins)
  const pins = normalizeStatusBarAccountPins(stored)
  const key = statusBarAccountPinKey(pin)
  const pinned = pins.some((entry) => statusBarAccountPinKey(entry) === key)
  const label = pinned
    ? translate('usage.accounts.unpinAccount', 'Unpin {{account}} from status bar', {
        account: pin.label
      })
    : translate('usage.accounts.pinAccount', 'Pin {{account}} to status bar', {
        account: pin.label
      })
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      aria-pressed={pinned}
      disabled={!setPins || (!pinned && pins.length >= MAX_STATUS_BAR_ACCOUNT_PINS)}
      onClick={() =>
        setPins(
          pinned ? pins.filter((entry) => statusBarAccountPinKey(entry) !== key) : [...pins, pin]
        )
      }
    >
      {pinned ? <PinOff size={12} /> : <Pin size={12} />}
    </Button>
  )
}
