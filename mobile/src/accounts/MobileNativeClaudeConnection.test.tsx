import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess } from '../transport/rpc-operation-test-families'
const mocks = vi.hoisted(() => ({ writeText: vi.fn(), openLink: vi.fn() }))
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  StyleSheet: { create: (value: unknown) => value }
}))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: mocks.writeText })
}))
vi.mock('../platform/external-link', () => ({ openExternalLink: mocks.openLink }))
import { MobileNativeClaudeConnection } from './MobileNativeClaudeConnection'
const reference = {
  accountId: 'existing-account',
  signInId: '23b77931-bc24-41e6-9e65-9bd427458be9'
}
const link =
  'https://platform.claude.com/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=synthetic&code_challenge=synthetic'
const waiting = { state: 'signing-in', link, requiresCode: true }
let tree: ReactTestRenderer | undefined
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  await act(async () => tree?.unmount())
  vi.useRealTimers()
  vi.clearAllMocks()
})
function client() {
  const c = new FakeSession('connected')
  c.sendRequest.mockImplementation(async (method) =>
    rpcSuccess(method === 'accounts.beginNativeClaudeRefreshSignIn' ? reference : waiting)
  )
  return c
}
function view(c: FakeSession, connected = true, onComplete = vi.fn()) {
  return createElement(MobileNativeClaudeConnection, {
    client: c,
    connected,
    accountId: reference.accountId,
    status: 'needs-sign-in',
    onComplete
  })
}
async function press(label: string) {
  const node = tree?.root
    .findAllByType('Pressable')
    .find((node) =>
      JSON.stringify(node.findAllByType('Text').map((child) => child.props.children)).includes(
        label
      )
    )
  if (!node) {
    throw new Error(`Missing ${label}`)
  }
  await act(async () => node.props.onPress())
}
it('uses same-account hosted sign-in, opens/copies its link and clears the secret before awaiting submit', async () => {
  const c = client(),
    complete = vi.fn()
  await act(async () => {
    tree = create(view(c, true, complete))
  })
  await press('Connect for CLI switching')
  expect(c.sendRequest).toHaveBeenCalledWith('accounts.beginNativeClaudeRefreshSignIn', {
    accountId: reference.accountId
  })
  expect(JSON.stringify(tree?.toJSON())).toContain('Paste sign-in code')
  await press('Open sign-in page')
  await press('Copy sign-in link')
  expect(mocks.openLink).toHaveBeenCalledWith(link)
  expect(mocks.writeText).toHaveBeenCalledWith(link)
  const input = tree?.root.findByType('TextInput')
  expect(input?.props.secureTextEntry).toBe(true)
  await act(async () => input?.props.onChangeText('synthetic-code#state'))
  c.sendRequest.mockImplementation(async (method) => {
    if (method === 'accounts.submitNativeClaudeRefreshSignInCode') {
      return new Promise(() => {})
    }
    return rpcSuccess(waiting)
  })
  await press('Confirm sign-in code')
  expect(tree?.root.findByType('TextInput').props.value).toBe('')
  expect(c.sendRequest).toHaveBeenCalledWith('accounts.submitNativeClaudeRefreshSignInCode', {
    ...reference,
    code: 'synthetic-code#state'
  })
  expect(complete).not.toHaveBeenCalled()
})
it('pauses background polling, resumes once, and cancels only its own attempt', async () => {
  const c = client()
  await act(async () => {
    tree = create(view(c))
  })
  await press('Connect for CLI switching')
  await act(async () => tree?.update(view(c, false)))
  const calls = c.sendRequest.mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(30000))
  expect(c.sendRequest).toHaveBeenCalledTimes(calls)
  await act(async () => tree?.update(view(c)))
  expect(c.sendRequest).toHaveBeenCalledTimes(calls + 1)
  await press('Cancel sign-in')
  expect(c.sendRequest).toHaveBeenLastCalledWith(
    'accounts.cancelNativeClaudeRefreshSignIn',
    reference
  )
  expect(JSON.stringify(tree?.toJSON())).not.toContain('Paste sign-in code')
})
it('rejects stale host completion and never marks a needs-sign-in terminal result successful', async () => {
  const old = client(),
    next = client(),
    complete = vi.fn()
  let finish: (result: ReturnType<typeof rpcSuccess>) => void = () => {}
  old.sendRequest.mockImplementation(async (method) =>
    method === 'accounts.beginNativeClaudeRefreshSignIn'
      ? rpcSuccess(reference)
      : new Promise((resolve) => {
          finish = resolve
        })
  )
  await act(async () => {
    tree = create(view(old, true, complete))
  })
  await press('Connect for CLI switching')
  await act(async () => {
    tree?.update(view(next, true, complete))
    finish(rpcSuccess({ state: 'ready', link: null }))
  })
  expect(complete).not.toHaveBeenCalled()
  next.sendRequest.mockImplementation(async (method) =>
    rpcSuccess(
      method === 'accounts.beginNativeClaudeRefreshSignIn'
        ? reference
        : { state: 'needs-sign-in', link: null }
    )
  )
  await press('Connect for CLI switching')
  expect(complete).not.toHaveBeenCalled()
  expect(JSON.stringify(tree?.toJSON())).toContain('was not completed')
})
it('reports success only when its own sign-in reaches ready', async () => {
  const c = client(),
    complete = vi.fn()
  c.sendRequest.mockImplementation(async (method) =>
    rpcSuccess(
      method === 'accounts.beginNativeClaudeRefreshSignIn'
        ? reference
        : { state: 'ready', link: null }
    )
  )
  await act(async () => {
    tree = create(view(c, true, complete))
  })
  await press('Connect for CLI switching')
  expect(complete).toHaveBeenCalledTimes(1)
  expect(c.sendRequest).not.toHaveBeenCalledWith(
    'accounts.cancelNativeClaudeRefreshSignIn',
    reference
  )
})
it('keeps account consent distinct from ordinary shell installation', async () => {
  const c = client()
  const props = {
    client: c,
    connected: true,
    accountId: reference.accountId,
    status: 'ready' as const,
    onComplete: vi.fn()
  }
  await act(async () => {
    tree = create(
      createElement(MobileNativeClaudeConnection, { ...props, shellSetupInstalled: false })
    )
  })
  expect(JSON.stringify(tree?.toJSON())).toContain('Account connected')
  expect(JSON.stringify(tree?.toJSON())).not.toContain('CLI switching ready')
  await act(async () =>
    tree?.update(
      createElement(MobileNativeClaudeConnection, { ...props, shellSetupInstalled: true })
    )
  )
  expect(JSON.stringify(tree?.toJSON())).toContain('CLI switching ready')
  expect(c.sendRequest).not.toHaveBeenCalled()
})
