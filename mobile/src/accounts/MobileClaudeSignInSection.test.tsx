import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess, rpcRefusal } from '../transport/rpc-operation-test-families'
const push = vi.hoisted(() => vi.fn())
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 }
}))
vi.mock('../navigation/route-handoff', () => ({ useRouteHandoff: () => ({ push }) }))
vi.mock('../components/PickerModal', () => ({
  PickerModal: (props: Record<string, unknown>) => createElement('Picker', props)
}))
import { MobileClaudeSignInSection } from './MobileClaudeSignInSection'
const inventory = {
  worktrees: [
    { id: 'folder:project', displayName: 'Project', path: '/test' },
    { id: 'copy-two', displayName: 'Second copy', path: '/test-two' }
  ]
}
const receipt = {
  terminal: {
    handle: 'term-test',
    worktreeId: 'copy-two',
    tabId: 'tab-test',
    leafId: 'leaf-test',
    executionHostId: 'runtime:server-one'
  }
}
let tree: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => tree?.unmount())
  vi.clearAllMocks()
})
async function mount(client: FakeSession) {
  await act(async () => {
    tree = create(
      createElement(MobileClaudeSignInSection, { client, connected: true, hostId: 'host-one' })
    )
  })
}
async function choose() {
  await act(async () => tree?.root.findByType('Pressable').props.onPress())
  expect(tree?.root.findByType('Picker').props.visible).toBe(true)
  await act(async () => tree?.root.findByType('Picker').props.onSelect('copy-two'))
}
it('opens Claude sign-in on the selected host workspace and navigates to its exact terminal', async () => {
  const client = new FakeSession('connected')
  client.sendRequest
    .mockResolvedValueOnce(rpcSuccess(inventory))
    .mockResolvedValueOnce(rpcSuccess(receipt))
  await mount(client)
  await choose()
  expect(client.sendRequest).toHaveBeenCalledWith('worktree.list', { limit: 100 })
  expect(client.sendRequest).toHaveBeenCalledWith('accounts.openSignInTerminal', {
    provider: 'claude',
    worktree: 'id:copy-two',
    clientMutationId: expect.any(String)
  })
  expect(push).toHaveBeenCalledWith(
    '/h/host-one/session/copy-two?paneKey=tab-test%3Aleaf-test&executionHost=runtime%3Aserver-one'
  )
})
it('retries a failed request with the same mutation identity', async () => {
  const client = new FakeSession('connected')
  client.sendRequest
    .mockResolvedValueOnce(rpcSuccess(inventory))
    .mockResolvedValueOnce(rpcRefusal('timeout', 'Connection timed out'))
    .mockResolvedValueOnce(rpcSuccess(inventory))
    .mockResolvedValueOnce(rpcSuccess(receipt))
  await mount(client)
  await choose()
  expect(JSON.stringify(tree?.toJSON())).toContain('Connection timed out')
  await choose()
  const calls = client.sendRequest.mock.calls.filter(
    ([method]) => method === 'accounts.openSignInTerminal'
  )
  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual(calls[0])
  expect(push).toHaveBeenCalledTimes(1)
})
it('ignores an open-terminal reply after the host view is unmounted', async () => {
  const client = new FakeSession('connected')
  let reply: (value: ReturnType<typeof rpcSuccess>) => void = () => {
    throw new Error('not pending')
  }
  client.sendRequest.mockResolvedValueOnce(rpcSuccess(inventory)).mockImplementationOnce(
    async () =>
      await new Promise<ReturnType<typeof rpcSuccess>>((resolve) => {
        reply = resolve
      })
  )
  await mount(client)
  await choose()
  await act(async () => {
    tree?.unmount()
  })
  await act(async () => {
    reply(rpcSuccess(receipt))
  })
  expect(push).not.toHaveBeenCalled()
})
