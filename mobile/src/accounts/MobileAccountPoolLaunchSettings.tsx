import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { AccountPoolPolicy } from '../../../src/shared/account-pool-policy'
import { PickerModal } from '../components/PickerModal'
import { MobileSwitch } from '../components/MobileSwitch'
import { poolStyles } from './mobile-account-pool-styles'
import { styles } from './mobile-accounts-screen-styles'

export function MobileAccountPoolLaunchSettings({
  policy,
  disabled,
  onChange
}: {
  policy: AccountPoolPolicy
  disabled: boolean
  onChange: (policy: AccountPoolPolicy) => void
}) {
  const [open, setOpen] = useState(false)
  const options = [
    { value: 'off', label: 'Automatic switching off' },
    { value: 'on-limit', label: 'Switch when limited' },
    { value: 'after-turn', label: 'Switch between completed turns' }
  ]
  return (
    <View style={poolStyles.content}>
      <View style={poolStyles.toggleRow}>
        <Text style={[styles.rowTitle, styles.rowMain]}>Use pool for new chats and workers</Text>
        <MobileSwitch
          accessibilityLabel={`${policy.provider} apply pool to new work`}
          disabled={disabled}
          value={policy.applyToNewWork}
          onValueChange={(applyToNewWork) => onChange({ ...policy, applyToNewWork })}
        />
      </View>
      <View style={poolStyles.toggleRow}>
        <Text style={[styles.rowTitle, styles.rowMain]}>Allow reserve accounts</Text>
        <MobileSwitch
          accessibilityLabel={`${policy.provider} allow reserve accounts`}
          disabled={disabled}
          value={policy.allowReserve}
          onValueChange={(allowReserve) => onChange({ ...policy, allowReserve })}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${policy.provider} account switching`}
        disabled={disabled}
        style={poolStyles.action}
        onPress={() => setOpen(true)}
      >
        <Text style={poolStyles.actionText}>
          {options.find((option) => option.value === policy.rotation)?.label}
        </Text>
      </Pressable>
      <Text style={styles.rowSubtitle}>
        New built-in chats, managed terminal agents and workers use this host pool. Assigned
        sessions switch after active work, tools and approvals finish. Existing unpooled chats and
        external CLI sessions keep their own login.
      </Text>
      <PickerModal
        visible={open && !disabled}
        title="Account switching"
        selected={policy.rotation}
        options={options}
        onClose={() => setOpen(false)}
        onSelect={(rotation) => {
          if (rotation === 'off' || rotation === 'on-limit' || rotation === 'after-turn') {
            onChange({ ...policy, rotation })
          }
          setOpen(false)
        }}
      />
    </View>
  )
}
