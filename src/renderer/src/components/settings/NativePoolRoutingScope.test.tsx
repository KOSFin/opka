// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  NativePoolConnection,
  NativePoolRoutingNotice,
  NativePoolRoutingScope
} from './NativePoolRoutingScope'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('./RemoteAccountSignInSection', () => ({
  RemoteAccountSignInSection: ({ routingAccount }: { routingAccount: { accountId: string } }) => (
    <button>Connect {routingAccount.accountId}</button>
  )
}))
vi.mock('./NativeClaudeSignInSection', () => ({
  NativeClaudeSignInSection: ({ accountId }: { accountId: string }) => (
    <button>Connect Claude {accountId}</button>
  )
}))
const id = '10000000-0000-4000-8000-000000000001'
const otherId = '10000000-0000-4000-8000-000000000002'
const target = { kind: 'environment', environmentId: 'host-a' } as const
const snapshot = {
  capability: 'accounts.native-codex-routing.v1',
  supported: true,
  accounts: [
    { accountId: id, rosterRevision: 'r1', status: 'ready' },
    { accountId: otherId, rosterRevision: 'r2', status: 'needs-sign-in' }
  ]
}
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
function view(
  environmentId: string = target.environmentId,
  enabled = true,
  provider: 'claude' | 'codex' = 'codex'
) {
  const owner = { kind: 'environment', environmentId } as const
  return (
    <NativePoolRoutingScope
      target={owner}
      hostLabel={environmentId}
      enabled={enabled}
      provider={provider}
    >
      <NativePoolRoutingNotice />
      <NativePoolConnection target={owner} hostLabel={environmentId} accountId={id} />
      <NativePoolConnection target={owner} hostLabel={environmentId} accountId={otherId} />
    </NativePoolRoutingScope>
  )
}

it('uses the separate Claude connection on the same existing account row', async () => {
  rpc.mockResolvedValue({
    accounts: [
      { accountId: id, state: 'needs-sign-in' },
      { accountId: otherId, state: 'ready', nativeVersion: '2.1.318' }
    ]
  })
  render(view('host-a', true, 'claude'))
  expect(await screen.findByRole('button', { name: `Connect Claude ${id}` })).toBeTruthy()
  expect(screen.getByText('CLI switching ready')).toBeTruthy()
  expect(rpc).toHaveBeenCalledWith(
    target,
    'accounts.nativeClaudeRefreshSources',
    undefined,
    expect.any(Object)
  )
  expect(screen.queryByRole('button', { name: `Connect ${otherId}` })).toBeNull()
})

it('reads once for the expanded provider and shows existing-account connections without polling', async () => {
  rpc.mockResolvedValue(snapshot)
  render(view())
  expect(await screen.findByText('CLI switching ready')).toBeTruthy()
  expect(screen.getByRole('button', { name: `Connect ${otherId}` })).toBeTruthy()
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(rpc).toHaveBeenCalledWith(
    target,
    'accounts.codexRoutingState',
    undefined,
    expect.any(Object)
  )
})

it('refreshes an account connected outside this screen without starting background polling', async () => {
  rpc.mockResolvedValue(snapshot)
  render(view())
  await screen.findByRole('button', { name: `Connect ${otherId}` })
  rpc.mockResolvedValue({
    ...snapshot,
    accounts: snapshot.accounts.map((account) => ({ ...account, status: 'ready' }))
  })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh CLI connections' }))
  await waitFor(() => expect(screen.getAllByText('CLI switching ready')).toHaveLength(2))
  expect(screen.queryByRole('button', { name: `Connect ${otherId}` })).toBeNull()
  expect(rpc).toHaveBeenCalledTimes(2)
})

it.each(['not-installed', 'installed', 'missing-launcher'] as const)(
  'distinguishes account consent from %s shell setup',
  async (mode) => {
    rpc.mockResolvedValue({
      ...snapshot,
      shellSetup: {
        supported: true,
        state: mode === 'not-installed' ? mode : 'installed',
        missing: mode === 'missing-launcher' ? ['orca'] : []
      }
    })
    render(view())
    await screen.findByRole('button', { name: 'Refresh CLI connections' })
    if (mode === 'installed') {
      expect(screen.getByText('CLI switching ready')).toBeTruthy()
      expect(screen.queryByText(/agent native-shell/)).toBeNull()
    } else {
      expect(screen.getByText('Account connected')).toBeTruthy()
      expect(screen.queryByText('CLI switching ready')).toBeNull()
      if (mode === 'not-installed') {
        expect(screen.getByRole('button', { name: 'Set up ordinary CLI' })).toBeTruthy()
      } else {
        expect(screen.getByText(/Opka CLI/)).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Set up ordinary CLI' })).toBeNull()
      }
    }
    expect(rpc).toHaveBeenCalledTimes(1)
  }
)

it('does not request routing for a collapsed or other provider', () => {
  render(view('host-a', false))
  expect(rpc).not.toHaveBeenCalled()
})

it('does not retain another host connection state or apply a late reply after an owner change', async () => {
  let finish: (value: unknown) => void = () => {}
  rpc.mockImplementation((owner) =>
    owner.environmentId === 'host-a'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve({
          ...snapshot,
          accounts: snapshot.accounts.map((account) => ({ ...account, status: 'needs-sign-in' }))
        })
  )
  const mounted = render(view())
  mounted.rerender(view('host-b'))
  expect(await screen.findByRole('button', { name: `Connect ${id}` })).toBeTruthy()
  finish(snapshot)
  await waitFor(() => expect(screen.queryByText('CLI switching ready')).toBeNull())
})

it('offers recovery when the host predates routing instead of hiding account controls', async () => {
  rpc.mockRejectedValueOnce(new Error('Unknown method'))
  rpc.mockResolvedValueOnce(snapshot)
  render(view())
  fireEvent.click(await screen.findByRole('button', { name: 'Retry CLI connection' }))
  expect(await screen.findByText('CLI switching ready')).toBeTruthy()
  expect(rpc).toHaveBeenCalledTimes(2)
})

it('sets up the selected scope once and refreshes that same host once', async () => {
  const ready = { supported: true, state: 'installed', missing: [] } as const
  rpc
    .mockResolvedValueOnce({ ...snapshot, shellSetup: { ...ready, state: 'not-installed' } })
    .mockResolvedValueOnce(ready)
    .mockResolvedValueOnce({ ...snapshot, shellSetup: ready })
  render(view('host-b'))
  fireEvent.click(await screen.findByRole('button', { name: 'Set up ordinary CLI' }))
  await screen.findByText('Ordinary CLI commands are ready on host-b.')
  expect(rpc.mock.calls.map(([owner, method]) => [owner, method])).toEqual([
    [{ kind: 'environment', environmentId: 'host-b' }, 'accounts.codexRoutingState'],
    [{ kind: 'environment', environmentId: 'host-b' }, 'accounts.installNativeCliIntegration'],
    [{ kind: 'environment', environmentId: 'host-b' }, 'accounts.codexRoutingState']
  ])
})

it('keeps the selected-host failure visible after its one status refresh', async () => {
  const initial = {
    ...snapshot,
    shellSetup: { supported: true, state: 'not-installed', missing: [] }
  }
  rpc
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new Error('/private/error'))
    .mockResolvedValueOnce({ ...initial })
  render(view('host-b'))
  fireEvent.click(await screen.findByRole('button', { name: 'Set up ordinary CLI' }))
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(3))
  expect(await screen.findByText(/CLI setup on host-b could not be confirmed/)).toBeTruthy()
  expect(screen.queryByText('/private/error')).toBeNull()
})
