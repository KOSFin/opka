import { useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import type { AccountPoolPolicy } from '../../../src/shared/account-pool-policy'
import { PickerModal } from '../components/PickerModal'
import { poolStyles } from './mobile-account-pool-styles'
import { styles } from './mobile-accounts-screen-styles'

type Member = AccountPoolPolicy['members'][number]
const roles = [
  { value: 'primary', label: 'Primary' },
  { value: 'reserve', label: 'Reserve' },
  { value: 'manual', label: 'Manual only' }
]

export function MobileAccountPoolMemberSettings({
  member,
  accountLabel,
  balanced,
  disabled,
  onChange
}: {
  member: Member
  accountLabel: string
  balanced: boolean
  disabled: boolean
  onChange: (member: Member) => void
}) {
  const [open, setOpen] = useState(false)
  const fields: ('priority' | 'weight')[] = balanced ? ['priority', 'weight'] : ['priority']
  return (
    <View style={poolStyles.memberSettings}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${accountLabel} pool role`}
        disabled={disabled}
        style={poolStyles.action}
        onPress={() => setOpen(true)}
      >
        <Text style={poolStyles.actionText}>
          Role: {roles.find((role) => role.value === member.role)?.label}
        </Text>
      </Pressable>
      {fields.map((field) => (
        <View key={field} style={poolStyles.priority}>
          <Text style={styles.rowSubtitle}>{field === 'priority' ? 'Priority' : 'Weight'}</Text>
          <TextInput
            accessibilityLabel={`${accountLabel} ${field}`}
            keyboardType="number-pad"
            editable={!disabled}
            value={String(member[field])}
            style={poolStyles.input}
            onChangeText={(text) => {
              const value = Number(text)
              const max = field === 'priority' ? 1000 : 100
              if (Number.isInteger(value) && value >= 1 && value <= max) {
                onChange({ ...member, [field]: value })
              }
            }}
          />
        </View>
      ))}
      <PickerModal
        visible={open && !disabled}
        title="Account role"
        selected={member.role}
        options={roles}
        onClose={() => setOpen(false)}
        onSelect={(role) => {
          if (role === 'primary' || role === 'reserve' || role === 'manual') {
            onChange({ ...member, role })
          }
          setOpen(false)
        }}
      />
    </View>
  )
}
