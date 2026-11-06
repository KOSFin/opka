// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AccountPoolViewSchema,
  accountPoolDrafts,
  setPoolMembership
} from '../../../../shared/account-pool-view'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { AccountPoolSection } from './AccountPoolSection'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const snapshot = AccountPoolViewSchema.parse({
  capability: 'orchestration.account-pools.v1',
  policies: [],
  accounts: {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [{ id: 'a', email: 'a@test.invalid' }], activeAccountId: 'a' }
  },
  candidates: [],
  assignments: []
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
const target = { kind: 'local' } as const
function pane(refreshKey = 'initial') {
  return (
    <AccountPoolSection
      target={target}
      hostLabel="Local"
      provider="codex"
      refreshKey={refreshKey}
      renderAccount={(_id, controls, blocked) => (
        <div role="group" aria-label="Saved account">
          <span>a@test.invalid</span>
          <button disabled={blocked}>Choose account</button>
          {controls}
        </div>
      )}
      fallbackAccounts={(blocked) => <button disabled={blocked}>Fallback selection</button>}
    />
  )
}
it('retains one roster after a failed refresh instead of rendering the fallback too', async () => {
  rpc.mockResolvedValue(snapshot)
  render(pane())
  await screen.findByRole('group', { name: 'Saved account' })
  rpc.mockImplementation((_target, method) =>
    method === 'accounts.list'
      ? Promise.reject(new Error('Connection unavailable'))
      : Promise.resolve(snapshot)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Refresh accounts and limits' }))
  await screen.findByRole('alert')
  expect(screen.getAllByText('a@test.invalid')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: 'Fallback selection' })).toBeNull()
})
it('removes deleted roster members while preserving unrelated unsaved edits', async () => {
  const initial = AccountPoolViewSchema.parse({
    ...snapshot,
    accounts: {
      ...snapshot.accounts,
      codex: {
        ...snapshot.accounts.codex,
        accounts: [
          ...snapshot.accounts.codex.accounts,
          { id: 'removed', email: 'removed@test.invalid' }
        ]
      }
    }
  })
  const policy = setPoolMembership(
    setPoolMembership(accountPoolDrafts(initial)[1], 'a', 'enabled'),
    'removed',
    'enabled'
  )
  policy.revision = 5
  let latest = { ...initial, policies: [policy] }
  rpc.mockImplementation(() => Promise.resolve(latest))
  const ui = render(pane())
  await screen.findByRole('button', { name: 'Save Codex settings' })
  fireEvent.click(screen.getByRole('switch', { name: 'Use automatic pool' }))
  latest = { ...latest, accounts: snapshot.accounts }
  ui.rerender(pane('deleted'))
  await waitFor(() =>
    expect(rpc.mock.calls.filter((call) => call[1] === 'accountPool.list')).toHaveLength(2)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save Codex settings' }))
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(target, 'accountPool.update', {
      expectedRevision: 5,
      policy: {
        ...policy,
        strategy: 'sequential',
        applyToNewWork: true,
        members: [policy.members[0]]
      }
    })
  )
})
it('ignores an older usage projection that completes after a successful policy save', async () => {
  let finish: ((value: unknown) => void) | undefined
  let reads = 0
  const policy = { ...accountPoolDrafts(snapshot)[1], revision: 1 }
  const old = { ...snapshot, policies: [policy] }
  const saved = {
    ...snapshot,
    policies: [{ ...policy, revision: 2, strategy: 'sequential', applyToNewWork: true }]
  }
  rpc.mockImplementation((_target, method) => {
    if (method !== 'accountPool.list') {
      return Promise.resolve({})
    }
    reads += 1
    if (reads === 1) {
      return Promise.resolve(old)
    }
    if (reads === 2) {
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    return Promise.resolve(saved)
  })
  const ui = render(pane())
  await screen.findByRole('button', { name: 'Save Codex settings' })
  fireEvent.click(screen.getByRole('switch', { name: 'Use automatic pool' }))
  ui.rerender(pane('usage-push'))
  await waitFor(() => expect(finish).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Save Codex settings' }))
  await screen.findByText(/Codex pool saved on/)
  await act(async () => finish?.(old))
  expect(
    screen.getByRole('switch', { name: 'Use automatic pool' }).getAttribute('aria-checked')
  ).toBe('true')
  expect(screen.getByRole('button', { name: 'Choose account' }).hasAttribute('disabled')).toBe(true)
})
it.each([
  { code: 'unknown_method', blocked: false },
  { code: 'runtime_unavailable', blocked: true }
])(
  'allows legacy manual selection only for explicit unsupported policy RPC: %s',
  async ({ code, blocked }) => {
    rpc.mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'read',
        ok: false,
        error: { code, message: 'Host policy unavailable' }
      })
    )
    render(pane())
    const fallback = await screen.findByRole('button', { name: 'Fallback selection' })
    expect(fallback.hasAttribute('disabled')).toBe(blocked)
    expect(screen.queryByRole('button', { name: 'Save Codex settings' })).toBeNull()
  }
)
