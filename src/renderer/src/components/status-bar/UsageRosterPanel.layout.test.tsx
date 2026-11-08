import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('./UsageAccountsContext', () => ({
  useUsageAccounts: () => ({
    target: { kind: 'local' },
    snapshot: null,
    verified: false,
    ownerLabel: 'Synthetic host',
    rateLimits: createEmptyRateLimitState()
  })
}))
vi.mock('./UsageAccountRows', () => ({
  UsageAccountRows: ({ provider }: { provider: string }) => <div data-account-provider={provider} />
}))
vi.mock('./UsageCodexAccountRows', () => ({
  UsageCodexAccountRows: () => <div data-account-provider="codex" />
}))
vi.mock('@/hooks/useResetCountdownClock', () => ({ useResetCountdownClock: () => 1_000 }))
vi.mock('@/i18n/i18n', async (original) => ({
  ...(await original()),
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))
vi.mock('@/components/settings/SettingsFormControls', () => ({
  SettingsSegmentedControl: () => <span data-view-picker />
}))

import { UsageRosterPanel } from './UsageRosterPanel'

const provider = (name: ProviderRateLimits['provider']): ProviderRateLimits => ({
  provider: name,
  session: null,
  weekly: null,
  status: 'ok',
  error: null,
  updatedAt: 1
})

it('places accounts directly after the single Usage header and keeps other providers and history', () => {
  const markup = renderToStaticMarkup(
    <UsageRosterPanel
      providers={[provider('claude'), provider('codex'), provider('gemini')]}
      display="used"
      statusBarUsageMode="compact"
      onStatusBarUsageModeChange={() => {}}
      isRefreshing={false}
      onRefresh={() => {}}
      onOpenProvider={() => {}}
      onSignIn={() => {}}
      canSignIn={() => false}
      onManageAccounts={() => {}}
      onUsageDetails={() => {}}
    />
  )
  expect(markup.match(/data-account-provider=/g)).toHaveLength(2)
  expect(markup).not.toContain('Accounts (')
  expect(markup.indexOf('data-account-provider=')).toBeLessThan(markup.indexOf('data-usage-mode='))
  expect(markup).toContain('Synthetic host')
  expect(markup).toContain('data-view-picker')
  expect(markup).toContain('Gemini')
  expect(markup).toContain('Usage details &amp; history')
})
