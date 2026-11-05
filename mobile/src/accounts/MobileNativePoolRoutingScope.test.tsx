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
vi.mock('./MobileNativeClaudeConnection', () => ({
  MobileNativeClaudeConnection: 'MobileNativeClaudeConnection'
}))
vi.mock('./MobileAccountSignInSection', () => ({
  MobileAccountSignInSection: 'MobileAccountSignInSection'
}))
import {
  MobileNativePoolRoutingScope,
  MobileNativePoolRoutingNotice,
  MobileNativePoolConnection
} from './MobileNativePoolRoutingScope'

const accountId = '10000000-0000-4000-8000-000000000001'
const snapshot = {
  capability: 'accounts.native-codex-routing.v1',
  supported: true,
  accounts: [{ accountId, rosterRevision: 'r1', status: 'ready' }]
}
let tree: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => tree?.unmount())
})
function view(client: FakeSession, connected = true, enabled = true) {
  return (
    <MobileNativePoolRoutingScope
      target={{ client, connected, hostName: 'Server' }}
      enabled={enabled}
    >
      <MobileNativePoolRoutingNotice />
      <MobileNativePoolConnection accountId={accountId} />
    </MobileNativePoolRoutingScope>
  )
}

it('reads only on expansion and reconnect, retaining same-host state while hidden', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(rpcSuccess(snapshot))
  await act(async () => {
    tree = create(view(client, true, false))
  })
  expect(client.sendRequest).not.toHaveBeenCalled()
  await act(async () => tree?.update(view(client)))
  expect(client.sendRequest).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(tree?.toJSON())).toContain('CLI switching ready')
  await act(async () => tree?.update(view(client, false)))
  expect(client.sendRequest).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(tree?.toJSON())).toContain('CLI switching ready')
  await act(async () => tree?.update(view(client)))
  expect(client.sendRequest).toHaveBeenCalledTimes(2)
})

it('refreshes a connection completed elsewhere on the same host', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(rpcSuccess(snapshot))
  await act(async () => {
    tree = create(view(client))
  })
  const refresh = tree?.root
    .findAllByType('Pressable')
    .find((item) =>
      item.findAllByType('Text').some((text) => text.props.children === 'Refresh CLI connections')
    )
  expect(refresh).toBeTruthy()
  client.sendRequest.mockResolvedValue(
    rpcSuccess({
      ...snapshot,
      accounts: [{ accountId, rosterRevision: 'r1', status: 'needs-sign-in' }]
    })
  )
  await act(async () => refresh?.props.onPress())
  expect(tree?.root.findByType('MobileAccountSignInSection').props.routingAccount.accountId).toBe(
    accountId
  )
  expect(client.sendRequest).toHaveBeenCalledTimes(2)
})

it('ignores the previous host reply and connects the same roster account on the new host', async () => {
  const previous = new FakeSession('connected')
  let finish: (value: ReturnType<typeof rpcSuccess>) => void = () => {}
  previous.sendRequest.mockImplementation(
    () =>
      new Promise<ReturnType<typeof rpcSuccess>>((resolve) => {
        finish = resolve
      })
  )
  const current = new FakeSession('connected')
  current.sendRequest.mockResolvedValue(
    rpcSuccess({ ...snapshot, accounts: [{ ...snapshot.accounts[0], status: 'needs-sign-in' }] })
  )
  await act(async () => {
    tree = create(view(previous))
  })
  await act(async () => tree?.update(view(current)))
  await act(async () => finish(rpcSuccess(snapshot)))
  expect(JSON.stringify(tree?.toJSON())).not.toContain('CLI switching ready')
  const connection = tree?.root.findByType('MobileAccountSignInSection')
  expect(connection?.props.client).toBe(current)
  expect(connection?.props.routingAccount).toEqual({ accountId, expectedRosterRevision: 'r1' })
})

it('retains visible account controls and provides retry for an older host', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockRejectedValueOnce(new Error('Unknown method'))
  client.sendRequest.mockResolvedValueOnce(rpcSuccess(snapshot))
  await act(async () => {
    tree = create(view(client))
  })
  expect(JSON.stringify(tree?.toJSON())).toContain('unavailable on this host')
  await act(async () => tree?.root.findByType('Pressable').props.onPress())
  expect(JSON.stringify(tree?.toJSON())).toContain('CLI switching ready')
  expect(client.sendRequest).toHaveBeenCalledTimes(2)
})

it('reads Claude sources for the same roster row and ignores a stale Codex provider reply', async () => {
  const client = new FakeSession('connected')
  let finish: (value: ReturnType<typeof rpcSuccess>) => void = () => {}
  client.sendRequest.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  client.sendRequest.mockResolvedValue(
    rpcSuccess({ accounts: [{ accountId, state: 'needs-sign-in' }] })
  )
  await act(async () => {
    tree = create(view(client))
  })
  await act(async () =>
    tree?.update(
      <MobileNativePoolRoutingScope
        provider="claude"
        target={{ client, connected: true, hostName: 'Server' }}
        enabled
      >
        <MobileNativePoolConnection accountId={accountId} />
      </MobileNativePoolRoutingScope>
    )
  )
  await act(async () => finish(rpcSuccess(snapshot)))
  expect(client.sendRequest).toHaveBeenCalledWith('accounts.nativeClaudeRefreshSources')
  expect(tree?.root.findByType('MobileNativeClaudeConnection').props.accountId).toBe(accountId)
  expect(JSON.stringify(tree?.toJSON())).not.toContain('CLI switching ready')
})

it.each(['not-installed', 'installed', 'modified', 'unsupported'] as const)(
  'shows one host setup notice for %s without extra RPC requests',
  async (state) => {
    const client = new FakeSession('connected')
    client.sendRequest.mockResolvedValue(
      rpcSuccess({
        ...snapshot,
        shellSetup: {
          supported: state !== 'unsupported',
          state,
          missing: []
        }
      })
    )
    await act(async () => {
      tree = create(view(client))
    })
    const rendered = JSON.stringify(tree?.toJSON())
    if (state === 'installed') {
      expect(rendered).toContain('Ordinary CLI commands are ready')
      expect(rendered).toContain('CLI switching ready')
      expect(rendered).not.toContain('agent native-shell install')
    } else {
      expect(rendered).toContain('Account connected')
      expect(rendered).not.toContain('CLI switching ready')
      if (state === 'not-installed') {
        expect(rendered.match(/Set up ordinary CLI/g)).toHaveLength(1)
      } else if (state === 'modified') {
        expect(rendered).toContain('agent native-shell status')
      } else {
        expect(rendered).toContain('CLI setup is unavailable')
      }
    }
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  }
)

it('does not claim full readiness when installed shell files outlive the host launcher', async () => {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue(
    rpcSuccess({
      ...snapshot,
      shellSetup: { supported: true, state: 'installed', missing: ['orca'] }
    })
  )
  await act(async () => {
    tree = create(view(client))
  })
  const rendered = JSON.stringify(tree?.toJSON())
  expect(rendered).toContain('Account connected')
  expect(rendered).toContain('Opka CLI')
  expect(rendered).not.toContain('CLI switching ready')
})

it('sets up through the selected client once then refreshes its existing scope once', async () => {
  const client = new FakeSession('connected')
  const ready = { supported: true, state: 'installed', missing: [] } as const
  client.sendRequest
    .mockResolvedValueOnce(
      rpcSuccess({ ...snapshot, shellSetup: { ...ready, state: 'not-installed' } })
    )
    .mockResolvedValueOnce(rpcSuccess(ready))
    .mockResolvedValueOnce(rpcSuccess({ ...snapshot, shellSetup: ready }))
  await act(async () => {
    tree = create(view(client))
  })
  const setup = tree?.root
    .findAllByType('Pressable')
    .find((node) =>
      node.findAllByType('Text').some((text) => text.props.children === 'Set up ordinary CLI')
    )
  expect(setup).toBeTruthy()
  await act(async () => setup?.props.onPress())
  expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
    'accounts.codexRoutingState',
    'accounts.installNativeCliIntegration',
    'accounts.codexRoutingState'
  ])
  expect(JSON.stringify(tree?.toJSON())).toContain('Ordinary CLI commands are ready on Server.')
})

it('keeps a setup failure visible after refreshing the same selected host once', async () => {
  const client = new FakeSession('connected')
  const initial = {
    ...snapshot,
    shellSetup: { supported: true, state: 'not-installed', missing: [] }
  }
  client.sendRequest
    .mockResolvedValueOnce(rpcSuccess(initial))
    .mockRejectedValueOnce(new Error('/private/error'))
    .mockResolvedValueOnce(rpcSuccess({ ...initial }))
  await act(async () => {
    tree = create(view(client))
  })
  const setup = tree?.root
    .findAllByType('Pressable')
    .find((node) =>
      node.findAllByType('Text').some((text) => text.props.children === 'Set up ordinary CLI')
    )
  await act(async () => setup?.props.onPress())
  expect(client.sendRequest).toHaveBeenCalledTimes(3)
  expect(JSON.stringify(tree?.toJSON())).toContain('CLI setup on Server could not be confirmed')
  expect(JSON.stringify(tree?.toJSON())).not.toContain('/private/error')
})
