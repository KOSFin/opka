import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AccountPoolViewSchema,
  accountPoolDrafts,
  setPoolMembership
} from '../../../src/shared/account-pool-view'
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
vi.mock('../components/MobileSwitch', () => ({ MobileSwitch: 'MobileSwitch' }))
vi.mock('./MobileNativeClaudeConnection', () => ({
  MobileNativeClaudeConnection: 'MobileNativeClaudeConnection'
}))
vi.mock('./MobileAccountSignInSection', () => ({
  MobileAccountSignInSection: 'MobileAccountSignInSection'
}))
vi.mock('lucide-react-native', () => ({ ChevronDown: 'ChevronDown', ChevronRight: 'ChevronRight' }))
import { MobileAccountPoolSection } from './MobileAccountPoolSection'

const initial = AccountPoolViewSchema.parse({
  capability: 'orchestration.account-pools.v1',
  policies: [],
  accounts: {
    claude: { accounts: [], activeAccountId: null },
    codex: {
      accounts: [
        { id: 'kept', email: 'kept@example.test' },
        { id: 'removed', email: 'removed@example.test' }
      ],
      activeAccountId: 'kept'
    }
  },
  candidates: [],
  assignments: []
})
let tree: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => tree?.unmount())
})

const reason =
  'Compared verified 7d usage; selected lower observed usage. Selected 41%, current 62%.'
const equalizePolicy = {
  ...setPoolMembership(accountPoolDrafts(initial)[1], 'kept', 'enabled'),
  strategy: 'quota-equalize' as const,
  applyToNewWork: true,
  revision: 3
}
const reasonView = AccountPoolViewSchema.parse({
  ...initial,
  equalizeCapability: 'orchestration.account-pools.equalize.v1',
  policies: [equalizePolicy],
  assignments: [
    {
      ownerKey: 'synthetic-work',
      provider: 'codex',
      accountId: 'kept',
      poolId: equalizePolicy.id,
      selectionReason: reason
    }
  ]
})
const visibleReason = () => JSON.stringify(tree!.toJSON()).includes(reason)
const openCodex = async () => {
  await act(async () =>
    tree!.root.findByProps({ accessibilityLabel: 'Codex pool settings' }).props.onPress()
  )
}

it('shows a verified host decision beside its saved account and hides foreign or absent reasons', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(rpcSuccess(reasonView))
  const props = { client, connected: true, hostName: 'Host A', refreshKey: 0 }
  await act(async () => {
    tree = create(createElement(MobileAccountPoolSection, props))
  })
  await openCodex()
  expect(visibleReason()).toBe(true)
  expect(JSON.stringify(tree!.toJSON())).toContain('Host selection for running work:')

  const foreign = {
    ...reasonView,
    assignments: [{ ...reasonView.assignments[0], accountId: 'removed' }]
  }
  client.sendRequest.mockResolvedValue(rpcSuccess(foreign))
  await act(async () =>
    tree!.update(createElement(MobileAccountPoolSection, { ...props, refreshKey: 1 }))
  )
  expect(visibleReason()).toBe(false)

  client.sendRequest.mockResolvedValue(
    rpcSuccess({
      ...reasonView,
      assignments: [{ ...reasonView.assignments[0], poolId: 'other-pool' }]
    })
  )
  await act(async () =>
    tree!.update(createElement(MobileAccountPoolSection, { ...props, refreshKey: 2 }))
  )
  expect(visibleReason()).toBe(false)

  client.sendRequest.mockResolvedValue(
    rpcSuccess({
      ...reasonView,
      assignments: [{ ...reasonView.assignments[0], selectionReason: null }]
    })
  )
  await act(async () =>
    tree!.update(createElement(MobileAccountPoolSection, { ...props, refreshKey: 3 }))
  )
  expect(visibleReason()).toBe(false)

  client.sendRequest.mockResolvedValue(
    rpcSuccess({
      ...reasonView,
      accounts: { ...reasonView.accounts, codex: { accounts: [], activeAccountId: null } }
    })
  )
  await act(async () =>
    tree!.update(createElement(MobileAccountPoolSection, { ...props, refreshKey: 4 }))
  )
  expect(visibleReason()).toBe(false)
})

it('does not present a retained decision during disconnect, failed refresh, or a late host change', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(rpcSuccess(reasonView))
  const props = { client, connected: true, hostName: 'Host A', refreshKey: 0 }
  await act(async () => {
    tree = create(createElement(MobileAccountPoolSection, props))
  })
  await openCodex()
  expect(visibleReason()).toBe(true)

  await act(async () =>
    tree!.update(createElement(MobileAccountPoolSection, { ...props, connected: false }))
  )
  expect(visibleReason()).toBe(false)

  client.sendRequest.mockRejectedValue(new Error('Host unavailable'))
  await act(async () =>
    tree!.update(createElement(MobileAccountPoolSection, { ...props, refreshKey: 1 }))
  )
  expect(visibleReason()).toBe(false)

  let finish: ((value: ReturnType<typeof rpcSuccess>) => void) | undefined
  client.sendRequest.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await act(async () =>
    tree!.update(
      createElement(MobileAccountPoolSection, { ...props, hostName: 'Host B', refreshKey: 2 })
    )
  )
  expect(visibleReason()).toBe(false)
  await act(async () => finish?.(rpcSuccess(reasonView)))
  await openCodex()
  expect(visibleReason()).toBe(true)
})

it('rejects a late old-host reason after the same client changes host identity', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(rpcSuccess(reasonView))
  const props = { client, connected: true, hostName: 'Host A', refreshKey: 0 }
  await act(async () => {
    tree = create(createElement(MobileAccountPoolSection, props))
  })
  await openCodex()
  let finishOld: ((value: ReturnType<typeof rpcSuccess>) => void) | undefined
  client.sendRequest.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve
      })
  )
  await act(async () =>
    tree!.update(createElement(MobileAccountPoolSection, { ...props, refreshKey: 1 }))
  )
  client.sendRequest.mockResolvedValue(rpcSuccess({ ...reasonView, assignments: [] }))
  await act(async () =>
    tree!.update(
      createElement(MobileAccountPoolSection, { ...props, hostName: 'Host B', refreshKey: 2 })
    )
  )
  await act(async () => finishOld?.(rpcSuccess(reasonView)))
  expect(visibleReason()).toBe(false)
})
