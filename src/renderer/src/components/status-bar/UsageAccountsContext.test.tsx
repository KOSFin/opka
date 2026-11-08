// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    onSelect
  }: {
    children: ReactNode
    onSelect: (event: { preventDefault: () => void }) => void
  }) => <span onClick={() => onSelect({ preventDefault: () => {} })}>{children}</span>
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
  await screen.findByRole('group', { name: 'Codex local@example.test usage' })
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
  expect(screen.queryByRole('group', { name: 'Codex local@example.test usage' })).toBeNull()
  expect(screen.getByRole('group', { name: 'Codex a@example.test usage' })).toBeTruthy()
  expect(mocks.watch).toHaveBeenCalledTimes(1)
  expect(mocks.close).toHaveBeenCalledTimes(1)
})
it('shows account rows immediately and opens details without another remote read', () => {
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
  const row = screen.getByRole('group', { name: 'Codex a@example.test usage' })
  const toggle = row.querySelector('button[aria-expanded]')
  expect(toggle?.getAttribute('aria-expanded')).toBe('false')
  if (toggle) {
    fireEvent.click(toggle)
  }
  expect(toggle?.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getAllByText('Limits unavailable').length).toBeGreaterThan(0)
  expect(mocks.watch).not.toHaveBeenCalled()
  expect(mocks.fetch).not.toHaveBeenCalled()
})
it('reveals the selected account’s reset count and confirmation from its focused Usage row', () => {
  mocks.watch.mockImplementation((_target, handlers) => {
    handlers.onSnapshot(source('active'))
    return { close: mocks.close }
  })
  const quota = {
    provider: 'codex' as const,
    session: {
      usedPercent: 62,
      windowMinutes: 300,
      resetsAt: Date.now() + 45 * 60_000,
      resetDescription: null
    },
    weekly: {
      usedPercent: 81,
      windowMinutes: 10_080,
      resetsAt: Date.now() + 2 * 86_400_000,
      resetDescription: null
    },
    rateLimitResetCredits: { availableCount: 2, nextExpiresAt: Date.now() + 3_600_000 },
    usageMetadata: { authProvenance: 'profile:active' },
    updatedAt: Date.now(),
    error: null,
    status: 'ok' as const
  }
  render(
    <UsageAccountsProvider
      target={local}
      snapshot={source('active')}
      verified
      rateLimits={{ ...createEmptyRateLimitState(), codex: quota }}
    >
      <UsageAccountRows provider="codex" now={Date.now()} display="used" />
    </UsageAccountsProvider>
  )
  const row = screen.getByRole('group', { name: 'Codex active@example.test usage' })
  expect(row.textContent).toContain('62%')
  expect(row.textContent).toContain('81%')
  expect(row.querySelector('.group-focus-within\\:block')).toBeTruthy()
  const toggle = row.querySelector('button[aria-expanded]')
  if (toggle) {
    fireEvent.focus(toggle)
  }
  expect(screen.getByText(/2 manual resets available/)).toBeTruthy()
  if (process.env.OPKA_SYNTHETIC_EVIDENCE_DIR) {
    writeFileSync(
      join(process.env.OPKA_SYNTHETIC_EVIDENCE_DIR, 'attempt-c57-usage-active.html'),
      `<html><head><meta charset="utf-8"><link rel="stylesheet" href="usage-evidence.css"></head><body><main style="width:360px;margin:48px auto;border:1px solid #ddd;background:#fff">${row.parentElement?.outerHTML}</main><script>document.querySelector('button[aria-expanded]')?.focus()</script></body></html>`
    )
  }
  fireEvent.click(screen.getByRole('button', { name: 'Use reset' }))
  expect(screen.getByRole('dialog').textContent).toContain('active@example.test')
})
it('selects a concrete inactive Codex profile without consuming its reset', () => {
  const snapshot = source('active')
  snapshot.codex.accounts.push({
    id: 'reserve',
    email: 'reserve@example.test',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  })
  const onSelectAccount = vi.fn()
  render(
    <UsageAccountsProvider
      target={a}
      snapshot={snapshot}
      verified
      rateLimits={{
        ...createEmptyRateLimitState(),
        inactiveCodexAccounts: [
          {
            accountId: 'reserve',
            rateLimits: {
              provider: 'codex',
              session: {
                usedPercent: 35,
                windowMinutes: 300,
                resetsAt: Date.now() + 90 * 60_000,
                resetDescription: null
              },
              weekly: {
                usedPercent: 55,
                windowMinutes: 10_080,
                resetsAt: Date.now() + 3 * 86_400_000,
                resetDescription: null
              },
              rateLimitResetCredits: { availableCount: 2, nextExpiresAt: Date.now() + 3_600_000 },
              usageMetadata: { authProvenance: 'profile:reserve' },
              updatedAt: Date.now(),
              status: 'ok',
              error: null
            },
            updatedAt: Date.now(),
            isFetching: false
          }
        ]
      }}
    >
      <UsageAccountRows
        provider="codex"
        now={Date.now()}
        display="used"
        onSelectAccount={onSelectAccount}
      />
    </UsageAccountsProvider>
  )
  const row = screen.getByRole('group', { name: 'Codex reserve@example.test usage' })
  expect(row.textContent).toContain('35%')
  expect(row.textContent).toContain('55%')
  const toggle = row.querySelector('button[aria-expanded]')
  expect(toggle).not.toBeNull()
  if (toggle) {
    fireEvent.click(toggle)
  }
  if (process.env.OPKA_SYNTHETIC_EVIDENCE_DIR) {
    writeFileSync(
      join(process.env.OPKA_SYNTHETIC_EVIDENCE_DIR, 'attempt-c57-usage-inactive.html'),
      `<html><head><meta charset="utf-8"><link rel="stylesheet" href="usage-evidence.css"></head><body><main style="width:360px;margin:48px auto;border:1px solid #ddd;background:#fff">${row.parentElement?.outerHTML}</main></body></html>`
    )
  }
  const select = screen.getByRole('button', { name: 'Select account to use reset' })
  fireEvent.click(select)
  expect(onSelectAccount).toHaveBeenCalledTimes(1)
  expect(onSelectAccount).toHaveBeenCalledWith('reserve')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: 'Use reset' }).hasAttribute('disabled')).toBe(true)
})
it('offers the real CLI login as a selectable account row', () => {
  const snapshot = source('active')
  snapshot.codex.systemDefault = {
    hasAuth: true,
    authKind: 'oauth',
    email: 'cli@example.test',
    providerAccountId: 'cli',
    workspaceLabel: null
  }
  const onSelectAccount = vi.fn()
  render(
    <UsageAccountsProvider target={a} snapshot={snapshot} verified>
      <UsageAccountRows
        provider="codex"
        now={Date.now()}
        display="used"
        onSelectAccount={onSelectAccount}
      />
    </UsageAccountsProvider>
  )
  const row = screen.getByRole('group', {
    name: 'Codex CLI login on this host · cli@example.test usage'
  })
  const toggle = row.querySelector('button[aria-expanded]')
  if (toggle) {
    fireEvent.click(toggle)
  }
  fireEvent.click(screen.getByRole('button', { name: 'Use CLI login' }))
  expect(onSelectAccount).toHaveBeenCalledWith(null)
  expect(screen.queryByRole('dialog')).toBeNull()
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
  await screen.findByRole('group', { name: 'Codex healthy@example.test usage' })
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
  act(() => deliveries[0](source('old')))
  await screen.findByRole('group', { name: 'Codex old@example.test usage' })
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
  expect(screen.queryByRole('group', { name: 'Codex late@example.test usage' })).toBeNull()
  expect(screen.queryByRole('group', { name: 'Codex old@example.test usage' })).toBeNull()
  act(() => deliveries[1](source('fresh')))
  await screen.findByRole('group', { name: 'Codex fresh@example.test usage' })
  expect(mocks.close).toHaveBeenCalledTimes(1)
})
