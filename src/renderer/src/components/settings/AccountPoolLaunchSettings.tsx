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
        label="Apply to new chats and workers"
        description="Use this provider pool for new built-in chats, managed terminal agents and workers on this host. Existing unpooled chats and external CLI sessions keep their own login."
        checked={policy.applyToNewWork}
        disabled={disabled}
        onChange={() => onChange({ ...policy, applyToNewWork: !policy.applyToNewWork })}
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
        Only supported sessions assigned to this pool can switch. Active work, tools and approvals
        must finish first. Unavailable hosts cannot confirm a safe switch.
      </p>
    </div>
  )
}
