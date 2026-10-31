import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess } from '../transport/rpc-operation-test-families'

const mocks = vi.hoisted(() => ({ writeText: vi.fn(), openLink: vi.fn() }))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: mocks.writeText })
}))
vi.mock('../platform/external-link', () => ({ openExternalLink: mocks.openLink }))
vi.mock('./MobileClaudeSignInSection', () => ({ MobileClaudeSignInSection: () => null }))
import { MobileAccountSignInSection } from './MobileAccountSignInSection'

const waiting = {
  id: '23b77931-bc24-41e6-9e65-9bd427458be9',
  provider: 'codex',
  status: 'waiting',
  verificationUrl: 'https://auth.openai.com/codex/device',
  userCode: 'AB12-C34D5',
  expiresAt: 2_000_000_000_000
} as const
let tree: ReactTestRenderer | undefined
beforeEach(() => {
  vi.useFakeTimers()
  mocks.writeText.mockResolvedValue(undefined)
})
afterEach(async () => {
  await act(async () => tree?.unmount())
  vi.useRealTimers()
  vi.clearAllMocks()
})
function text() {
  return JSON.stringify(tree?.toJSON())
}
async function press(label: string) {
  const button = tree?.root
    .findAll((node) => String(node.type) === 'Pressable')
    .find((node) =>
      JSON.stringify(
        node.findAll((child) => String(child.type) === 'Text').map((child) => child.props.children)
      ).includes(label)
    )
  if (!button) {
    throw new Error(`Missing ${label}`)
  }
  await act(async () => button.props.onPress())
}
async function mount(client: FakeSession, onComplete = vi.fn()) {
  await act(async () => {
    tree = create(
      createElement(MobileAccountSignInSection, {
        client,
        connected: true,
        hostName: 'Server A',
        hostId: 'host-a',
        onComplete
      })
    )
  })
}
function clientWithWaiting() {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(rpcSuccess(waiting))
  return client
}

it('opens the host authorization URL, copies its code and cancels only that pending sign-in', async () => {
  const client = clientWithWaiting()
  await mount(client)
  await press('Add Codex account')
  expect(client.sendRequest).toHaveBeenCalledWith('accounts.beginDeviceSignIn', {
    provider: 'codex'
  })
  expect(text()).toContain('AB12-C34D5')
  await press('Open sign-in page')
  expect(mocks.openLink).toHaveBeenCalledWith(waiting.verificationUrl)
  await press('Copy code')
  expect(mocks.writeText).toHaveBeenCalledWith(waiting.userCode)
  expect(text()).toContain('Code copied')
  await press('Cancel sign-in')
  expect(client.sendRequest).toHaveBeenCalledWith('accounts.cancelDeviceSignIn', { id: waiting.id })
  expect(text()).toContain('Add Codex account')
  expect(text()).not.toContain(waiting.userCode)
})

it('reports clipboard refusal without claiming the code was copied', async () => {
  const client = clientWithWaiting()
  mocks.writeText.mockRejectedValue(new Error('clipboard unavailable'))
  await mount(client)
  await press('Add Codex account')
  await press('Copy code')
  expect(text()).toContain('Could not copy the code')
  expect(text()).not.toContain('Code copied')
})

it('does not publish the previous host completion after its keyed view is replaced', async () => {
  const oldClient = clientWithWaiting()
  let finishPoll: (value: ReturnType<typeof rpcSuccess>) => void = () => {
    throw new Error('Poll not started')
  }
  oldClient.sendRequest.mockImplementation(async (method) => {
    if (method === 'accounts.deviceSignIn') {
      return await new Promise<ReturnType<typeof rpcSuccess>>((resolve) => {
        finishPoll = resolve
      })
    }
    return rpcSuccess(waiting)
  })
  const oldComplete = vi.fn()
  await act(async () => {
    tree = create(
      createElement(MobileAccountSignInSection, {
        key: 'host-a',
        client: oldClient,
        connected: true,
        hostName: 'Server A',
        hostId: 'host-a',
        onComplete: oldComplete
      })
    )
  })
  await press('Add Codex account')
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  const newComplete = vi.fn()
  await act(async () => {
    tree?.update(
      createElement(MobileAccountSignInSection, {
        key: 'host-b',
        client: clientWithWaiting(),
        connected: true,
        hostName: 'Server B',
        hostId: 'host-b',
        onComplete: newComplete
      })
    )
    finishPoll(rpcSuccess({ ...waiting, status: 'complete' }))
  })
  expect(oldComplete).not.toHaveBeenCalled()
  expect(newComplete).not.toHaveBeenCalled()
  expect(text()).toContain('Server B')
  expect(text()).not.toContain('Account added')
  expect(text()).not.toContain(waiting.userCode)
})
