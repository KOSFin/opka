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
import { MobileAccountPoolCard } from './MobileAccountPoolCard'

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
const codex = () =>
  tree!.root
    .findAllByType(MobileAccountPoolCard)
    .find((node) => node.props.policy.provider === 'codex')!

it.each(['projection', 'manual'] as const)(
  'filters removed accounts from dirty drafts during %s refresh',
  async (kind) => {
    const client = new FakeSession('connected')
    const policy = setPoolMembership(
      setPoolMembership(accountPoolDrafts(initial)[1], 'kept', 'enabled'),
      'removed',
      'enabled'
    )
    policy.revision = 22
    client.sendRequest.mockResolvedValue(rpcSuccess({ ...initial, policies: [policy] }))
    const props = { client, connected: true, hostName: 'Server', refreshKey: 0 }
    await act(async () => {
      tree = create(createElement(MobileAccountPoolSection, props))
    })
    await act(async () =>
      codex().props.onChange({
        ...codex().props.policy,
        rotation: 'after-turn',
        members: policy.members.map((member) => ({ ...member, priority: 9 }))
      })
    )
    const next = {
      ...initial,
      policies: [policy],
      accounts: {
        ...initial.accounts,
        codex: { accounts: [initial.accounts.codex.accounts[0]], activeAccountId: 'kept' }
      }
    }
    client.sendRequest.mockResolvedValue(rpcSuccess(next))
    await act(async () => {
      if (kind === 'projection') {
        tree!.update(createElement(MobileAccountPoolSection, { ...props, refreshKey: 1 }))
      } else {
        await tree!.root
          .findAllByType('Pressable')
          .find((node) => node.props.accessibilityLabel === 'Refresh pools')!
          .props.onPress()
      }
    })
    expect(codex().props.policy.rotation).toBe('after-turn')
    expect(codex().props.policy.revision).toBe(22)
    expect(codex().props.policy.members).toEqual([{ ...policy.members[0], priority: 9 }])
    await act(async () => codex().props.onSave())
    expect(client.sendRequest).toHaveBeenCalledWith('accountPool.update', {
      expectedRevision: 22,
      policy: {
        ...policy,
        rotation: 'after-turn',
        members: [{ ...policy.members[0], priority: 9 }]
      }
    })
  }
)

it('rejects a projection started before a successful save even when it returns last', async () => {
  const client = new FakeSession('connected')
  const policy = accountPoolDrafts(initial)[1]
  const committed = { ...policy, strategy: 'balanced' as const, applyToNewWork: true, revision: 1 }
  let finish: ((value: ReturnType<typeof rpcSuccess>) => void) | undefined
  const delayed = new Promise<ReturnType<typeof rpcSuccess>>((resolve) => {
    finish = resolve
  })
  let reads = 0
  client.sendRequest.mockImplementation(async (method) => {
    if (method === 'accountPool.update') {
      return rpcSuccess({})
    }
    reads += 1
    if (reads === 2) {
      return delayed
    }
    return rpcSuccess(reads === 1 ? initial : { ...initial, policies: [committed] })
  })
  const props = { client, connected: true, hostName: 'Server', refreshKey: 0 }
  await act(async () => {
    tree = create(createElement(MobileAccountPoolSection, props))
  })
  await act(async () => codex().props.onChange({ ...committed, revision: 0 }))
  await act(async () =>
    tree!.update(createElement(MobileAccountPoolSection, { ...props, refreshKey: 1 }))
  )
  await act(async () => codex().props.onSave())
  expect(codex().props.policy).toEqual(committed)
  await act(async () => finish?.(rpcSuccess(initial)))
  expect(codex().props.policy).toEqual(committed)
  expect(codex().props.dirty).toBe(false)
})

it('does not duplicate fallback account rows after a retained-view refresh error', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(rpcSuccess(initial))
  const props = {
    client,
    connected: true,
    hostName: 'Server',
    refreshKey: 0,
    presentation: { renderUnavailableAccounts: () => createElement('FallbackAccounts') }
  }
  await act(async () => {
    tree = create(createElement(MobileAccountPoolSection, props))
  })
  client.sendRequest.mockRejectedValue(new Error('Host unavailable'))
  await act(async () =>
    tree!.update(createElement(MobileAccountPoolSection, { ...props, refreshKey: 1 }))
  )
  expect(tree!.root.findAllByType(MobileAccountPoolCard)).toHaveLength(2)
  expect(tree!.root.findAllByType('FallbackAccounts')).toHaveLength(0)
})
