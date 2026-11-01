import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess } from '../transport/rpc-operation-test-families'
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
vi.mock('../components/AgentIcons', () => ({ ClaudeIcon: 'ClaudeIcon', OpenAIIcon: 'OpenAIIcon' }))
vi.mock('lucide-react-native', () => ({ ChevronDown: 'ChevronDown', ChevronRight: 'ChevronRight' }))
import { MobileAccountPoolSection } from './MobileAccountPoolSection'
vi.mock('../components/MobileSwitch', () => ({ MobileSwitch: 'MobileSwitch' }))
const snapshot = {
  capability: 'orchestration.account-pools.v1',
  policies: [],
  accounts: {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null }
  },
  candidates: [],
  assignments: []
}
let tree: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => tree?.unmount())
})
it('saves the selected mode with host revision and refreshes host state', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(rpcSuccess(snapshot))
  await act(async () => {
    tree = create(
      createElement(MobileAccountPoolSection, { client, connected: true, hostName: 'Server' })
    )
  })
  await act(async () =>
    tree?.root
      .findAllByType('Pressable')
      .find((node) => node.props.accessibilityLabel === 'Codex pool settings')
      ?.props.onPress()
  )
  await act(async () =>
    tree?.root
      .findAllByType('Pressable')
      .find((node) => node.props.accessibilityLabel === 'codex pool mode')
      ?.props.onPress()
  )
  await act(async () =>
    tree?.root
      .findAllByType('Picker')
      .find((node) => node.props.title === 'Pool mode')
      ?.props.onSelect('balanced')
  )
  await act(async () =>
    tree?.root
      .findAllByType('MobileSwitch')
      .find((node) => node.props.accessibilityLabel === 'codex apply pool to new work')
      ?.props.onValueChange(true)
  )
  await act(async () =>
    tree?.root
      .findAllByType('Pressable')
      .find((node) => node.props.accessibilityLabel === 'codex account switching')
      ?.props.onPress()
  )
  await act(async () =>
    tree?.root
      .findAllByType('Picker')
      .find((node) => node.props.visible && node.props.title === 'Account switching')
      ?.props.onSelect('on-limit')
  )
  await act(async () =>
    tree?.root
      .findAllByType('Pressable')
      .find((node) => node.props.accessibilityLabel === 'Save codex pool')
      ?.props.onPress()
  )
  expect(client.sendRequest).toHaveBeenCalledWith('accountPool.update', {
    expectedRevision: 0,
    policy: {
      id: 'codex-default',
      provider: 'codex',
      revision: 0,
      strategy: 'balanced',
      applyToNewWork: true,
      rotation: 'on-limit',
      unknownQuota: 'exclude',
      allowReserve: false,
      members: []
    }
  })
})
it('does not request or offer mutation controls while disconnected', async () => {
  const client = new FakeSession('connected')
  await act(async () => {
    tree = create(
      createElement(MobileAccountPoolSection, { client, connected: false, hostName: 'Server' })
    )
  })
  expect(client.sendRequest).not.toHaveBeenCalled()
  expect(tree?.root.findAllByType('Pressable').every((node) => node.props.disabled)).toBe(true)
})

it('retains an unsaved provider draft across collapse and host refresh without saving it', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(rpcSuccess(snapshot))
  await act(async () => {
    tree = create(
      createElement(MobileAccountPoolSection, { client, connected: true, hostName: 'Server' })
    )
  })
  const press = async (label: string) =>
    act(async () =>
      tree?.root
        .findAllByType('Pressable')
        .find((node) => node.props.accessibilityLabel === label)
        ?.props.onPress()
    )
  await press('Codex pool settings')
  await act(async () =>
    tree?.root
      .findAllByType('MobileSwitch')
      .find((node) => node.props.accessibilityLabel === 'codex apply pool to new work')
      ?.props.onValueChange(true)
  )
  await press('Codex pool settings')
  await press('Refresh pools')
  await press('Codex pool settings')
  expect(
    tree?.root
      .findAllByType('MobileSwitch')
      .find((node) => node.props.accessibilityLabel === 'codex apply pool to new work')?.props.value
  ).toBe(true)
  expect(
    client.sendRequest.mock.calls.filter(([method]) => method === 'accountPool.update')
  ).toHaveLength(0)
})

it('clears drafts and refuses captured save after a same-client authority migration', async () => {
  let generation = 0
  const client = Object.assign(new FakeSession('connected'), { getGeneration: () => generation })
  client.sendRequest.mockResolvedValue(rpcSuccess(snapshot))
  const props = { client, connected: true, hostName: 'Same display name' }
  await act(async () => {
    tree = create(createElement(MobileAccountPoolSection, props))
  })
  const { MobileAccountPoolCard } = await import('./MobileAccountPoolCard')
  const card = () =>
    tree!.root
      .findAllByType(MobileAccountPoolCard)
      .find((node) => node.props.policy.provider === 'codex')!
  await act(async () => card().props.onChange({ ...card().props.policy, strategy: 'balanced' }))
  const oldSave = card().props.onSave
  const oldChange = card().props.onChange
  const oldDiscard = card().props.onDiscard
  const oldPick = card().props.onPick
  await act(async () => oldPick())
  const oldPickerSelect = tree!.root
    .findAllByType('Picker')
    .find((node) => node.props.title === 'Pool mode')!.props.onSelect
  generation += 1
  await act(async () => oldSave())
  expect(client.sendRequest.mock.calls.some(([method]) => method === 'accountPool.update')).toBe(
    false
  )
  await act(async () =>
    tree!.update(createElement(MobileAccountPoolSection, { ...props, refreshKey: 1 }))
  )
  expect(card().props.policy.strategy).toBe('manual')
  expect(card().props.dirty).toBe(false)
  await act(async () => card().props.onChange({ ...card().props.policy, strategy: 'balanced' }))
  await act(async () => {
    oldChange({ ...card().props.policy, strategy: 'sequential' })
    oldDiscard()
    oldPick()
    oldPickerSelect('sequential')
  })
  expect(card().props.policy.strategy).toBe('balanced')
  expect(card().props.dirty).toBe(true)
  expect(tree!.root.findAllByType('Picker').filter((node) => node.props.visible)).toHaveLength(0)
})
