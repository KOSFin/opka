// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AccountPoolViewSchema,
  accountPoolDrafts,
  setPoolMembership
} from '../../../../shared/account-pool-view'
import { AccountPoolSection } from './AccountPoolSection'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{host}}', values?.host ?? '')
}))
const snapshot = {
  capability: 'orchestration.account-pools.v1',
  policies: [],
  accounts: {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [{ id: 'c1', email: 'test@example.test' }], activeAccountId: 'c1' }
  },
  candidates: [
    { provider: 'codex', accountId: 'c1', auth: 'ready', quota: 'unknown', usedPercent: null }
  ],
  assignments: []
}
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
it('reads and writes only the chosen execution host with revision fencing', async () => {
  rpc.mockResolvedValue(snapshot)
  const target = { kind: 'environment', environmentId: 'owner' } as const
  render(<AccountPoolSection target={target} hostLabel="Server" />)
  fireEvent.click(await screen.findByRole('button', { name: /Codex/ }))
  await screen.findByText('test@example.test · Manual default')
  expect(screen.getByText(/Auth: ready · Quota: unknown/)).toBeTruthy()
  const activation = screen.getByRole('switch', { name: 'Use automatic pool' })
  expect(activation.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(activation)
  fireEvent.click(screen.getByRole('button', { name: 'Save codex pool' }))
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(target, 'accountPool.update', {
      expectedRevision: 0,
      policy: {
        id: 'codex-default',
        provider: 'codex',
        revision: 0,
        strategy: 'sequential',
        applyToNewWork: true,
        rotation: 'off',
        unknownQuota: 'exclude',
        allowReserve: false,
        members: []
      }
    })
  )
  expect(await screen.findByText('Codex pool saved on Server.')).toBeTruthy()
})
it('fails closed on an older host without exposing editable policies', async () => {
  rpc.mockRejectedValue(new Error('Unknown method accountPool.list'))
  render(<AccountPoolSection target={{ kind: 'local' }} hostLabel="Local" />)
  expect((await screen.findByRole('alert')).textContent).toContain('Account pools unavailable')
  expect(screen.queryByRole('button', { name: 'Save codex pool' })).toBeNull()
})
it('retains the draft and reports a concurrent-edit rejection', async () => {
  rpc.mockImplementation((_target, method) =>
    method === 'accountPool.update'
      ? Promise.reject(new Error('Account pool changed; reload before saving'))
      : Promise.resolve(snapshot)
  )
  render(<AccountPoolSection target={{ kind: 'local' }} hostLabel="Local" />)
  fireEvent.click(await screen.findByRole('button', { name: /Codex/ }))
  await screen.findByRole('button', { name: 'Save codex pool' })
  fireEvent.click(screen.getByRole('button', { name: 'Save codex pool' }))
  expect((await screen.findByRole('alert')).textContent).toContain('reload before saving')
  expect(screen.queryByText('Codex pool saved on Local.')).toBeNull()
})

it('collapses providers without saving or discarding their draft', async () => {
  rpc.mockResolvedValue(snapshot)
  render(<AccountPoolSection target={{ kind: 'local' }} hostLabel="Local" />)
  const codex = await screen.findByRole('button', { name: /Codex/ })
  expect(codex.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('button', { name: 'Save codex pool' })).toBeNull()
  fireEvent.click(codex)
  fireEvent.click(screen.getByRole('switch', { name: 'Use automatic pool' }))
  fireEvent.click(codex)
  fireEvent.click(codex)
  expect(
    screen.getByRole('switch', { name: 'Use automatic pool' }).getAttribute('aria-checked')
  ).toBe('true')
  expect(
    rpc.mock.calls.every((call) =>
      ['accountPool.list', 'accounts.codexRoutingState'].includes(call[1])
    )
  ).toBe(true)
})

it('keeps save feedback inside its provider and clears it only when that draft changes', async () => {
  rpc.mockResolvedValue(snapshot)
  render(<AccountPoolSection target={{ kind: 'local' }} hostLabel="Local" />)
  fireEvent.click(await screen.findByRole('button', { name: /Codex/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Save codex pool' }))
  expect(await screen.findByText('Codex pool saved on Local.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
  const switches = screen.getAllByRole('switch', { name: 'Use automatic pool' })
  fireEvent.click(switches[0])
  expect(screen.getByText('Codex pool saved on Local.')).toBeTruthy()
  fireEvent.click(switches[1])
  expect(screen.queryByText('Codex pool saved on Local.')).toBeNull()
})

it('does not apply an old save after switching owners away and back', async () => {
  let finish: (() => void) | undefined
  rpc.mockImplementation((_target, method) =>
    method === 'accountPool.update'
      ? new Promise<void>((resolve) => {
          finish = resolve
        })
      : Promise.resolve(snapshot)
  )
  const a = { kind: 'environment', environmentId: 'a' } as const
  const b = { kind: 'environment', environmentId: 'b' } as const
  const view = render(<AccountPoolSection target={a} hostLabel="A" />)
  fireEvent.click(await screen.findByRole('button', { name: /Codex/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Save codex pool' }))
  view.rerender(<AccountPoolSection target={b} hostLabel="B" />)
  await waitFor(() =>
    expect(
      rpc.mock.calls.filter((call) => call[0] === b || call[0]?.environmentId === 'b')
    ).toHaveLength(1)
  )
  view.rerender(<AccountPoolSection target={a} hostLabel="A" />)
  await screen.findByRole('button', { name: /Codex/ })
  finish?.()
  await waitFor(() => expect(screen.queryByText('Codex pool saved on A.')).toBeNull())
  expect(rpc.mock.calls.filter((call) => call[1] === 'accountPool.list')).toHaveLength(3)
})

it('keeps the previous host hidden while loading and shows the new host error', async () => {
  rpc.mockResolvedValue(snapshot)
  const view = render(<AccountPoolSection target={{ kind: 'local' }} hostLabel="Local" />)
  await screen.findByRole('button', { name: /Codex/ })
  let fail = (_cause: Error) => {}
  const failure = new Promise<never>((_resolve, reject) => {
    fail = reject
  })
  rpc.mockReturnValueOnce(failure)
  view.rerender(
    <AccountPoolSection target={{ kind: 'environment', environmentId: 'b' }} hostLabel="B" />
  )
  expect(screen.queryByRole('button', { name: /Codex/ })).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('Loading account pools')
  fail(new Error('New host unavailable'))
  expect((await screen.findByRole('alert')).textContent).toContain('New host unavailable')
})

it('saves without invisible deleted registrations while preserving surviving membership', async () => {
  const policy = setPoolMembership(
    setPoolMembership(
      accountPoolDrafts(AccountPoolViewSchema.parse(snapshot))[1],
      'removed',
      'enabled'
    ),
    'c1',
    'draining'
  )
  policy.revision = 22
  rpc.mockResolvedValue({ ...snapshot, policies: [policy] })
  const target = { kind: 'environment', environmentId: 'owner' } as const
  render(<AccountPoolSection target={target} hostLabel="Server" />)
  fireEvent.click(await screen.findByRole('button', { name: /Codex/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Save codex pool' }))
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(target, 'accountPool.update', {
      expectedRevision: 22,
      policy: { ...policy, members: [policy.members[1]] }
    })
  )
})

it('embeds one account card with management and switching controls in the provider section', async () => {
  rpc.mockResolvedValue(snapshot)
  render(
    <AccountPoolSection
      target={{ kind: 'local' }}
      hostLabel="Local"
      provider="codex"
      renderAccount={(_id, controls, automatic) => (
        <div role="group" aria-label="test@example.test">
          <p>test@example.test</p>
          <button disabled={automatic}>Choose this account</button>
          <button>Remove account</button>
          {controls}
        </div>
      )}
    />
  )
  expect(await screen.findByText('test@example.test')).toBeTruthy()
  expect(screen.getAllByText('test@example.test')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: /Claude/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Remove account' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Choose this account' }).hasAttribute('disabled')).toBe(
    false
  )
  fireEvent.click(screen.getByRole('switch', { name: 'Use automatic pool' }))
  expect(screen.getByText('Selection mode: Automatic pool')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Choose this account' }).hasAttribute('disabled')).toBe(
    true
  )
  expect(screen.getByRole('button', { name: 'Save Codex settings' })).toBeTruthy()
})

it('updates host quota from a usage push without losing an unsaved mode change', async () => {
  let next = snapshot
  rpc.mockImplementation(() => Promise.resolve(next))
  const target = { kind: 'environment', environmentId: 'owner' } as const
  const ui = render(<AccountPoolSection target={target} hostLabel="Server" refreshKey="old" />)
  fireEvent.click(await screen.findByRole('button', { name: /Codex/ }))
  fireEvent.click(screen.getByRole('switch', { name: 'Use automatic pool' }))
  next = { ...snapshot, candidates: [{ ...snapshot.candidates[0], quota: 'available' }] }
  ui.rerender(<AccountPoolSection target={target} hostLabel="Server" refreshKey="fresh" />)
  expect(await screen.findByText(/Auth: ready · Quota: available/)).toBeTruthy()
  expect(
    screen.getByRole('switch', { name: 'Use automatic pool' }).getAttribute('aria-checked')
  ).toBe('true')
  expect(screen.getByText('Unsaved changes. Save to apply.')).toBeTruthy()
  expect(rpc.mock.calls.every((call) => call[1] !== 'accountPool.update')).toBe(true)
})

it('refreshes host usage before projecting pool quota and preserves a dirty draft', async () => {
  rpc.mockResolvedValue(snapshot)
  render(<AccountPoolSection target={{ kind: 'local' }} hostLabel="Local" />)
  fireEvent.click(await screen.findByRole('button', { name: /Codex/ }))
  fireEvent.click(screen.getByRole('switch', { name: 'Use automatic pool' }))
  rpc.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh pools' }))
  await waitFor(() =>
    expect(rpc.mock.calls.map((call) => call[1])).toEqual(['accounts.list', 'accountPool.list'])
  )
  expect(rpc.mock.calls[0][2]).toEqual({ refreshUsage: true })
  expect(
    screen.getByRole('switch', { name: 'Use automatic pool' }).getAttribute('aria-checked')
  ).toBe('true')
})
