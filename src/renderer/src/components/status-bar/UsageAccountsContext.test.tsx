// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import type * as I18nModule from '@/i18n/i18n'
import type * as AccountsModule from '@/runtime/runtime-provider-accounts-client'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import { UsageAccountsProvider, useUsageAccounts } from './UsageAccountsContext'
import { UsageAccountRows } from './UsageAccountRows'
import { useUsageAccountSource } from './use-usage-account-source'

const mocks = vi.hoisted(() => ({
  watch: vi.fn(),
  fetch: vi.fn(),
  claude: vi.fn(),
  codex: vi.fn(),
  close: vi.fn()
}))
vi.mock('@/runtime/runtime-provider-accounts-client', async (original) => ({
  ...(await original<typeof AccountsModule>()),
  watchProviderAccounts: mocks.watch,
  fetchProviderAccountsSnapshot: mocks.fetch
}))
vi.mock('../../store', () => ({
  useAppStore: (selector: (value: unknown) => unknown) =>
    selector({
      settings: null,
      fetchInactiveClaudeAccountUsage: mocks.claude,
      fetchInactiveCodexAccountUsage: mocks.codex
    })
}))
vi.mock('@/i18n/i18n', async (original) => ({
  ...(await original<typeof I18nModule>()),
  translate: (_key: string, text: string) => text
}))
const local = { kind: 'local' } as const
const a = { kind: 'environment', environmentId: 'a' } as const
const b = { kind: 'environment', environmentId: 'b' } as const
function source(id: string): ProviderAccountsSnapshot {
  return {
    claude: { accounts: [], activeAccountId: null },
    codex: {
      accounts: [
        { id, email: `${id}@example.test`, createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 }
      ],
      activeAccountId: id
    },
    rateLimits: createEmptyRateLimitState()
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.watch.mockImplementation(
    (
      _target: RuntimeClientTarget,
      handlers: { onSnapshot: (value: ProviderAccountsSnapshot) => void }
    ) => {
      handlers.onSnapshot(source('local'))
      return { close: mocks.close }
    }
  )
  mocks.fetch.mockResolvedValue(source('b'))
})
afterEach(cleanup)
it('refreshes local inactive usage on popup mount and closes its local watcher', async () => {
  const view = render(
    <UsageAccountsProvider
      target={local}
      snapshot={null}
      verified
      rateLimits={createEmptyRateLimitState()}
    >
      <UsageAccountRows provider="codex" now={1} display="used" />
    </UsageAccountsProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: /Accounts/ }))
  await screen.findByText('local@example.test')
  await waitFor(() => {
    expect(mocks.claude).toHaveBeenCalledTimes(1)
    expect(mocks.codex).toHaveBeenCalledTimes(1)
  })
  view.rerender(
    <UsageAccountsProvider
      target={a}
      snapshot={source('a')}
      verified
      rateLimits={createEmptyRateLimitState()}
    >
      <UsageAccountRows provider="codex" now={1} display="used" />
    </UsageAccountsProvider>
  )
  expect(screen.queryByText('local@example.test')).toBeNull()
  expect(screen.getByText('a@example.test')).toBeTruthy()
  expect(mocks.watch).toHaveBeenCalledTimes(1)
  expect(mocks.close).toHaveBeenCalledTimes(1)
})
it('reads and expands account rows without fetching another remote stream or selecting a login', () => {
  render(
    <UsageAccountsProvider
      target={a}
      snapshot={source('a')}
      verified
      rateLimits={createEmptyRateLimitState()}
    >
      <UsageAccountRows provider="codex" now={1} display="used" />
    </UsageAccountsProvider>
  )
  expect(screen.queryByText('a@example.test')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Accounts/ }))
  expect(screen.getByText('a@example.test')).toBeTruthy()
  expect(screen.getAllByText('Limits unavailable').length).toBeGreaterThan(0)
  expect(mocks.watch).not.toHaveBeenCalled()
  expect(mocks.fetch).not.toHaveBeenCalled()
})
function Probe({
  target,
  onRoster
}: {
  target: RuntimeClientTarget
  onRoster: (value: ProviderAccountsSnapshot['codex']) => void
}) {
  const { snapshot, loadAccounts } = useUsageAccountSource(target, 'codex', onRoster)
  useEffect(() => {
    void loadAccounts()
  }, [loadAccounts])
  return <span>{snapshot?.codex.accounts[0]?.email ?? 'pending'}</span>
}
it('never adopts another owner’s supplied context snapshot', async () => {
  const onRoster = vi.fn()
  render(
    <UsageAccountsProvider
      target={a}
      snapshot={source('a')}
      verified
      rateLimits={createEmptyRateLimitState()}
    >
      <Probe target={b} onRoster={onRoster} />
    </UsageAccountsProvider>
  )
  await screen.findByText('b@example.test')
  expect(screen.queryByText('a@example.test')).toBeNull()
  expect(mocks.fetch).toHaveBeenCalledWith(b)
  expect(onRoster).toHaveBeenCalledWith(source('b').codex)
})

function OwnerVerification() {
  const owner = useUsageAccounts()
  return <span data-testid="owner-verification">{owner?.verified ? 'verified' : 'unverified'}</span>
}
it('keeps a healthy partial snapshot verified when the failed provider reports its error', async () => {
  mocks.watch.mockImplementation((_target, handlers) => {
    handlers.onSnapshot({ ...source('healthy'), failedProviders: ['claude'] })
    handlers.onError(new Error('Claude unavailable'))
    return { close: mocks.close }
  })
  render(
    <UsageAccountsProvider target={local} snapshot={null} verified>
      <OwnerVerification />
      <UsageAccountRows provider="codex" now={1} display="used" />
    </UsageAccountsProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: /Accounts/ }))
  await screen.findByText('healthy@example.test')
  expect(screen.getByTestId('owner-verification').textContent).toBe('verified')
})
it('rejects late callbacks after switching away and returning to the local owner', async () => {
  const deliveries: ((snapshot: ProviderAccountsSnapshot) => void)[] = []
  mocks.watch.mockImplementation((_target, handlers) => {
    deliveries.push(handlers.onSnapshot)
    return { close: mocks.close }
  })
  const view = render(
    <UsageAccountsProvider target={local} snapshot={null} verified>
      <UsageAccountRows provider="codex" now={1} display="used" />
    </UsageAccountsProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: /Accounts/ }))
  act(() => deliveries[0](source('old')))
  await screen.findByText('old@example.test')
  view.rerender(
    <UsageAccountsProvider target={a} snapshot={source('remote')} verified>
      <UsageAccountRows provider="codex" now={1} display="used" />
    </UsageAccountsProvider>
  )
  view.rerender(
    <UsageAccountsProvider target={local} snapshot={null} verified>
      <UsageAccountRows provider="codex" now={1} display="used" />
    </UsageAccountsProvider>
  )
  act(() => deliveries[0](source('late')))
  expect(screen.queryByText('late@example.test')).toBeNull()
  expect(screen.queryByText('old@example.test')).toBeNull()
  act(() => deliveries[1](source('fresh')))
  await screen.findByText('fresh@example.test')
  expect(mocks.close).toHaveBeenCalledTimes(1)
})
