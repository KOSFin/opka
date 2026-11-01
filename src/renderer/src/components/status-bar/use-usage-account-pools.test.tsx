// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { AccountPoolViewSchema } from '../../../../shared/account-pool-view'
import { useUsageAccountPools } from './use-usage-account-pools'
const mocks = vi.hoisted(() => ({ owner: 'a', verified: true, read: vi.fn(), peek: vi.fn() }))
vi.mock('./UsageAccountsContext', () => ({
  useUsageAccounts: () => ({
    target: { kind: 'environment', environmentId: mocks.owner },
    verified: mocks.verified
  })
}))
vi.mock('./usage-account-pool-cache', () => ({
  readUsageAccountPools: mocks.read,
  peekUsageAccountPools: mocks.peek
}))
const view = AccountPoolViewSchema.parse({
  capability: 'orchestration.account-pools.v1',
  policies: [],
  accounts: {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null }
  },
  candidates: [],
  assignments: []
})
function Probe() {
  const state = useUsageAccountPools()
  return <span>{state.view ? (state.verified ? 'verified' : 'last-known') : 'unknown'}</span>
}
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  mocks.owner = 'a'
  mocks.verified = true
})
it('fences late responses and does not reread on ordinary snapshot rerenders', async () => {
  let finish: ((value: { view: typeof view; updatedAt: number }) => void) | undefined
  mocks.read
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    .mockResolvedValue({ view, updatedAt: 1 })
  const mounted = render(<Probe />)
  mounted.rerender(<Probe />)
  expect(mocks.read).toHaveBeenCalledTimes(1)
  mocks.owner = 'b'
  mounted.rerender(<Probe />)
  await screen.findByText('verified')
  mocks.verified = false
  mounted.rerender(<Probe />)
  expect(screen.getByText('last-known')).toBeTruthy()
  finish?.({ view, updatedAt: 1 })
  await waitFor(() => expect(screen.getByText('last-known')).toBeTruthy())
  expect(mocks.read).toHaveBeenCalledTimes(2)
})
it('retains cached metadata as last-known when the reread fails', async () => {
  mocks.peek.mockReturnValue({ view, updatedAt: 1 })
  mocks.read.mockRejectedValue(new Error('older host'))
  render(<Probe />)
  await screen.findByText('last-known')
  expect(mocks.read).toHaveBeenCalledTimes(1)
})
