import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { AccountPoolPolicy } from '../../../src/shared/account-pool-policy'
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  StyleSheet: { create: (value: unknown) => value }
}))
vi.mock('../components/PickerModal', () => ({
  PickerModal: (props: Record<string, unknown>) => createElement('Picker', props)
}))
import { MobileAccountPoolMemberSettings } from './MobileAccountPoolMemberSettings'

const member: AccountPoolPolicy['members'][number] = {
  accountId: 'owned-account',
  priority: 2,
  weight: 3,
  role: 'primary',
  state: 'draining',
  maxConcurrent: 4,
  cooldownUntil: 12345
}
let tree: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => tree?.unmount())
})
it('changes reserve role and balanced weight without resetting admission settings', async () => {
  const onChange = vi.fn()
  await act(async () => {
    tree = create(
      createElement(MobileAccountPoolMemberSettings, {
        member,
        accountLabel: 'Account',
        balanced: true,
        disabled: false,
        onChange
      })
    )
  })
  await act(async () => tree?.root.findByType('Pressable').props.onPress())
  expect(tree?.root.findByType('Picker').props.visible).toBe(true)
  await act(async () => tree?.root.findByType('Picker').props.onSelect('reserve'))
  expect(onChange).toHaveBeenLastCalledWith({ ...member, role: 'reserve' })
  const weight = tree?.root
    .findAllByType('TextInput')
    .find((node) => node.props.accessibilityLabel === 'Account weight')
  await act(async () => weight?.props.onChangeText('7'))
  expect(onChange).toHaveBeenLastCalledWith({ ...member, weight: 7 })
  onChange.mockClear()
  await act(async () => weight?.props.onChangeText('101'))
  await act(async () => weight?.props.onChangeText('1.5'))
  expect(onChange).not.toHaveBeenCalled()
})
it('keeps weight hidden outside balanced mode and disables disconnected controls', async () => {
  await act(async () => {
    tree = create(
      createElement(MobileAccountPoolMemberSettings, {
        member,
        accountLabel: 'Account',
        balanced: false,
        disabled: true,
        onChange: vi.fn()
      })
    )
  })
  expect(tree?.root.findAllByType('TextInput')).toHaveLength(1)
  expect(tree?.root.findByType('TextInput').props.editable).toBe(false)
  expect(tree?.root.findByType('Pressable').props.disabled).toBe(true)
  expect(tree?.root.findByType('Picker').props.visible).toBe(false)
})
