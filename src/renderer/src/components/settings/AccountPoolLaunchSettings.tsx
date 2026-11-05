import type { AccountPoolPolicy } from '../../../../shared/account-pool-policy'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsSwitchRow } from './SettingsFormControls'

export function AccountPoolLaunchSettings({
  policy,
  disabled,
  onChange
}: {
  policy: AccountPoolPolicy
  disabled: boolean
  onChange: (policy: AccountPoolPolicy) => void
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <SettingsSwitchRow
        label="Use automatic pool"
        description="The pool chooses accounts for new chats, workers and connected CLI launches on this host. With it off, new launches use your manual default."
        checked={policy.applyToNewWork && policy.strategy !== 'manual'}
        disabled={disabled}
        onChange={() =>
          onChange({
            ...policy,
            applyToNewWork: !(policy.applyToNewWork && policy.strategy !== 'manual'),
            strategy: policy.strategy === 'manual' ? 'sequential' : policy.strategy
          })
        }
      />
      <Select
        value={policy.rotation}
        disabled={disabled}
        onValueChange={(rotation) => {
          if (rotation === 'off' || rotation === 'on-limit' || rotation === 'after-turn') {
            onChange({ ...policy, rotation })
          }
        }}
      >
        <SelectTrigger aria-label={`${policy.provider} account switching`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="off">Automatic switching off</SelectItem>
          <SelectItem value="on-limit">Switch when limited</SelectItem>
          <SelectItem value="after-turn">Switch between completed turns</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Saved policy changes apply at the next supported boundary. Turning the pool off pauses
        switching in open CLI sessions and keeps their current account. Previously opened unmanaged
        CLI sessions need one relaunch to join the pool.
      </p>
    </div>
  )
}
