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
import { MobileAccountPoolSection } from './MobileAccountPoolSection'
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
      .findAllByType('Pressable')
      .find((node) => node.props.accessibilityLabel === 'codex apply pool to new work')
      ?.props.onPress()
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
