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
      <Text style={styles.rowTitle}>
        Selection mode:{' '}
        {policy.applyToNewWork && policy.strategy !== 'manual'
          ? 'Automatic pool'
          : 'Manual account'}
      </Text>
      <View style={poolStyles.toggleRow}>
        <Text style={[styles.rowTitle, styles.rowMain]}>Use automatic pool</Text>
        <MobileSwitch
          accessibilityLabel={`${policy.provider} apply pool to new work`}
          disabled={disabled}
          value={policy.applyToNewWork && policy.strategy !== 'manual'}
          onValueChange={(applyToNewWork) =>
            onChange({
              ...policy,
              applyToNewWork,
              strategy: policy.strategy === 'manual' ? 'sequential' : policy.strategy
            })
          }
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
        The pool replaces the manual default for new chats, workers and connected CLI launches.
        Saved changes apply at the next supported boundary. With the pool off, open CLI sessions
        keep their current account. Previously opened unmanaged CLIs need one relaunch.
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
