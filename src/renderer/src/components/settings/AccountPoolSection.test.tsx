// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
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
  await screen.findByText('test@example.test · Selected login')
  expect(screen.getByText(/Auth: ready · Quota: unknown/)).toBeTruthy()
  const activation = screen.getAllByRole('switch', { name: 'Apply to new chats and workers' })[1]
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
        strategy: 'manual',
        applyToNewWork: true,
        rotation: 'off',
        unknownQuota: 'exclude',
        allowReserve: false,
        members: []
      }
    })
  )
  expect(await screen.findByText('Pool saved on Server.')).toBeTruthy()
})
it('fails closed on an older host without exposing editable policies', async () => {
  rpc.mockRejectedValue(new Error('Unknown method accountPool.list'))
  render(<AccountPoolSection target={{ kind: 'local' }} hostLabel="Local" />)
  expect((await screen.findByRole('alert')).textContent).toContain('Account pools unavailable')
  expect(screen.queryByRole('button', { name: 'Save codex pool' })).toBeNull()
})
it('retains the draft and reports a concurrent-edit rejection', async () => {
  rpc
    .mockResolvedValueOnce(snapshot)
    .mockRejectedValueOnce(new Error('Account pool changed; reload before saving'))
  render(<AccountPoolSection target={{ kind: 'local' }} hostLabel="Local" />)
  await screen.findByRole('button', { name: 'Save codex pool' })
  fireEvent.click(screen.getByRole('button', { name: 'Save codex pool' }))
  expect((await screen.findByRole('alert')).textContent).toContain('reload before saving')
  expect(screen.queryByText('Pool saved on Local.')).toBeNull()
})
