import { AccountPoolUpdateParams } from '../../../src/shared/account-pool-policy'
import {
  AccountPoolViewSchema,
  accountPoolDrafts,
  setPoolMembership
} from '../../../src/shared/account-pool-view'
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
vi.mock('./MobileNativeClaudeConnection', () => ({
  MobileNativeClaudeConnection: 'MobileNativeClaudeConnection'
}))
vi.mock('./MobileAccountSignInSection', () => ({
  MobileAccountSignInSection: 'MobileAccountSignInSection'
}))
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

it('reveals provider-specific account addition only inside the opened pool section', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(rpcSuccess(snapshot))
  await act(async () => {
    tree = create(
      createElement(MobileAccountPoolSection, {
        client,
        connected: true,
        hostName: 'Server',
        presentation: {
          renderProviderSignIn: (provider: 'claude' | 'codex') =>
            createElement('Text', null, `Add ${provider} account`)
        }
      })
    )
  })
  expect(JSON.stringify(tree?.toJSON())).not.toContain('Add codex account')
  await act(async () =>
    tree?.root
      .findAllByType('Pressable')
      .find((node) => node.props.accessibilityLabel === 'Codex pool settings')
      ?.props.onPress()
  )
  expect(JSON.stringify(tree?.toJSON())).toContain('Add codex account')
  expect(JSON.stringify(tree?.toJSON())).not.toContain('Add claude account')
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

it('saves without invisible deleted registrations while preserving surviving membership', async () => {
  const client = new FakeSession('connected')
  const policy = setPoolMembership(
    setPoolMembership(
      accountPoolDrafts(AccountPoolViewSchema.parse(snapshot))[1],
      'removed',
      'enabled'
    ),
    'retained',
    'draining'
  )
  policy.revision = 22
  const view = {
    ...snapshot,
    policies: [policy],
    accounts: {
      ...snapshot.accounts,
      codex: {
        accounts: [{ id: 'retained', email: 'synthetic@example.test' }],
        activeAccountId: 'retained'
      }
    }
  }
  client.sendRequest.mockResolvedValue(rpcSuccess(view))
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
      .find((node) => node.props.accessibilityLabel === 'Save codex pool')
      ?.props.onPress()
  )
  expect(client.sendRequest).toHaveBeenCalledWith('accountPool.update', {
    expectedRevision: 22,
    policy: { ...policy, members: [policy.members[1]] }
  })
})

it('uses one account row and keeps manual selection blocked until pool-off is saved', async () => {
  const client = new FakeSession('connected')
  let view = AccountPoolViewSchema.parse({
    ...snapshot,
    accounts: {
      ...snapshot.accounts,
      codex: { accounts: [{ id: 'c1', email: 'one@example.test' }], activeAccountId: 'c1' }
    }
  })
  client.sendRequest.mockImplementation(async (method, params) => {
    if (method === 'accountPool.update') {
      const update = AccountPoolUpdateParams.parse(params)
      view = { ...view, policies: [{ ...update.policy, revision: update.expectedRevision + 1 }] }
      return rpcSuccess({})
    }
    return rpcSuccess(view)
  })
  await act(async () => {
    tree = create(
      createElement(MobileAccountPoolSection, {
        client,
        connected: true,
        hostName: 'Server',
        presentation: {
          renderAccount: (_provider, accountId, blocked) =>
            createElement('SavedAccount', { accountId, blocked })
        }
      })
    )
  })
  const blocked = () => tree!.root.findByType('SavedAccount').props.blocked
  const toggle = async (value: boolean) =>
    act(async () =>
      tree!.root
        .findAllByType('MobileSwitch')
        .find((node) => node.props.accessibilityLabel === 'codex apply pool to new work')!
        .props.onValueChange(value)
    )
  const save = async () =>
    act(async () =>
      tree!.root
        .findAllByType('Pressable')
        .find((node) => node.props.accessibilityLabel === 'Save codex pool')!
        .props.onPress()
    )
  expect(tree!.root.findAllByType('SavedAccount')).toHaveLength(0)
  await act(async () =>
    tree!.root
      .findAllByType('Pressable')
      .find((node) => node.props.accessibilityLabel === 'Codex pool settings')!
      .props.onPress()
  )
  expect(tree!.root.findAllByType('SavedAccount')).toHaveLength(1)
  expect(blocked()).toBe(false)
  await toggle(true)
  expect(blocked()).toBe(true)
  expect(client.sendRequest.mock.calls.some(([method]) => method === 'accountPool.update')).toBe(
    false
  )
  await save()
  await toggle(false)
  expect(blocked()).toBe(true)
  await save()
  expect(blocked()).toBe(false)
  expect(
    client.sendRequest.mock.calls.filter(([method]) => method === 'accountPool.update')
  ).toHaveLength(2)
})

it.each([
  ['Unknown method accountPool.list', false],
  ['Host disconnected', true]
] as const)(
  'keeps the account list visible when pool settings fail: %s',
  async (message, blocked) => {
    const client = new FakeSession('connected')
    client.sendRequest.mockRejectedValue(new Error(message))
    await act(async () => {
      tree = create(
        createElement(MobileAccountPoolSection, {
          client,
          connected: true,
          hostName: 'Server',
          presentation: {
            renderUnavailableAccounts: (manualSelectionBlocked) =>
              createElement('FallbackAccountRows', { blocked: manualSelectionBlocked })
          }
        })
      )
    })
    expect(tree!.root.findByType('FallbackAccountRows').props.blocked).toBe(blocked)
  }
)
