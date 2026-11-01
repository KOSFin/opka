// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import type * as I18nModule from '@/i18n/i18n'
import type * as AccountsModule from '@/runtime/runtime-provider-accounts-client'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import { UsageAccountsProvider } from './UsageAccountsContext'
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
