import { StrictMode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess } from '../transport/rpc-operation-test-families'
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (value: unknown) => value }
}))
import { MobileNativeShellSetupControl } from './MobileNativeShellSetupControl'
const missing = { supported: true, state: 'not-installed', missing: [] } as const
const ready = { supported: true, state: 'installed', missing: [] } as const
let tree: ReactTestRenderer | undefined
const done = vi.fn()
afterEach(async () => {
  await act(async () => tree?.unmount())
  vi.clearAllMocks()
})
function button(label: string) {
  const item = tree?.root
    .findAllByType('Pressable')
    .find((node) => node.findAllByType('Text').some((text) => text.props.children === label))
  if (!item) {
    throw new Error(`Missing ${label}`)
  }
  return item
}
it('installs only on explicit click with one request/refresh and works under StrictMode', async () => {
  const client = new FakeSession('connected')
  let finish: (value: ReturnType<typeof rpcSuccess>) => void = () => {}
  client.sendRequest.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await act(async () => {
    tree = create(
      <StrictMode>
        <MobileNativeShellSetupControl
          setup={{ ...missing, missing: [] }}
          client={client}
          connected
          hostName="Build server"
          onComplete={done}
        />
      </StrictMode>
    )
  })
  expect(client.sendRequest).not.toHaveBeenCalled()
  await act(async () => button('Set up ordinary CLI').props.onPress())
  expect(button('Setting up…').props.disabled).toBe(true)
  await act(async () => button('Setting up…').props.onPress())
  expect(client.sendRequest).toHaveBeenCalledExactlyOnceWith('accounts.installNativeCliIntegration')
  await act(async () => finish(rpcSuccess(ready)))
  expect(done).toHaveBeenCalledTimes(1)
  expect(button('Remove CLI setup')).toBeTruthy()
  expect(JSON.stringify(tree?.toJSON())).toContain('Build server')
})
it('does not publish an old-host result or act while inactive', async () => {
  const first = new FakeSession('connected'),
    second = new FakeSession('connected')
  let finish: (value: ReturnType<typeof rpcSuccess>) => void = () => {}
  first.sendRequest.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await act(async () => {
    tree = create(
      <MobileNativeShellSetupControl
        setup={{ ...missing, missing: [] }}
        client={first}
        connected
        hostName="First"
        onComplete={done}
      />
    )
  })
  await act(async () => button('Set up ordinary CLI').props.onPress())
  await act(async () =>
    tree?.update(
      <MobileNativeShellSetupControl
        setup={{ ...missing, missing: [] }}
        client={second}
        connected={false}
        hostName="Second"
        onComplete={done}
      />
    )
  )
  await act(async () => finish(rpcSuccess(ready)))
  expect(done).not.toHaveBeenCalled()
  expect(button('Set up ordinary CLI').props.disabled).toBe(true)
  expect(JSON.stringify(tree?.toJSON())).not.toContain('First')
  expect(second.sendRequest).not.toHaveBeenCalled()
})
it('keeps modified/unknown setup read-only and preserves reduced private errors', async () => {
  const client = new FakeSession('connected')
  await act(async () => {
    tree = create(
      <MobileNativeShellSetupControl
        setup={{ supported: true, state: 'modified', missing: [] }}
        client={client}
        connected
        hostName="Server"
        onComplete={done}
      />
    )
  })
  expect(JSON.stringify(tree?.toJSON())).toContain('agent native-shell status')
  await act(async () => button('Refresh setup status').props.onPress())
  expect(done).toHaveBeenCalledTimes(1)
  expect(client.sendRequest).not.toHaveBeenCalled()
  await act(async () =>
    tree?.update(
      <MobileNativeShellSetupControl
        setup={{ ...ready, missing: [] }}
        client={client}
        connected
        hostName="Server"
        onComplete={done}
      />
    )
  )
  client.sendRequest.mockRejectedValue(new Error('/private/host/error'))
  await act(async () => button('Remove CLI setup').props.onPress())
  expect(client.sendRequest).toHaveBeenCalledExactlyOnceWith(
    'accounts.uninstallNativeCliIntegration'
  )
  expect(JSON.stringify(tree?.toJSON())).not.toContain('/private/')
  expect(JSON.stringify(tree?.toJSON())).toContain('could not be confirmed')
})
