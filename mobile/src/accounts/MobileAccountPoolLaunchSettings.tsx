import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { AccountPoolPolicy } from '../../../src/shared/account-pool-policy'
import { PickerModal } from '../components/PickerModal'
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
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel={`${policy.provider} apply pool to new work`}
        accessibilityState={{ checked: policy.applyToNewWork, disabled }}
        disabled={disabled}
        style={poolStyles.action}
        onPress={() => onChange({ ...policy, applyToNewWork: !policy.applyToNewWork })}
      >
        <Text style={poolStyles.actionText}>
          New chats and workers: {policy.applyToNewWork ? 'pool enabled' : 'pool off'}
        </Text>
      </Pressable>
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
