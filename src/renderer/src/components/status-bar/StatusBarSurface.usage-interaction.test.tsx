// @vitest-environment happy-dom
import React from 'react'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '../../store'

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  resetRpc: vi.fn()
}))

vi.mock('./use-status-bar-controller', async () => {
  const React = await import('react')
  return {
    useStatusBarController: () => {
      const [usageMenuOpen, setUsageMenuOpen] = React.useState(false)
      const ref = React.useRef(null)
      const codex: ProviderRateLimits = {
        provider: 'codex',
        status: 'ok',
        error: null,
        updatedAt: Date.now(),
        session: { usedPercent: 42, windowMinutes: 300, resetsAt: null, resetDescription: null },
        weekly: null,
        usageMetadata: { authProvenance: 'profile:active' },
        rateLimitResetCredits: { availableCount: 2, nextExpiresAt: Date.now() + 3_600_000 }
      }
      const claude: ProviderRateLimits = {
        ...codex,
        provider: 'claude',
        usageMetadata: { authProvenance: 'profile:claude' },
        rateLimitResetCredits: undefined
      }
      return {
        accountSnapshot: {
          claude: {
            accounts: [
              {
                id: 'claude',
                email: 'claude@example.test',
                createdAt: 1,
                updatedAt: 1,
                lastAuthenticatedAt: 1
              }
            ],
            activeAccountId: 'claude'
          },
          codex: {
            accounts: [
              {
                id: 'active',
                email: 'active@example.test',
                createdAt: 1,
                updatedAt: 1,
                lastAuthenticatedAt: 1
              },
              {
                id: 'reserve',
                email: 'reserve@example.test',
                createdAt: 1,
                updatedAt: 1,
                lastAuthenticatedAt: 1
              }
            ],
            activeAccountId: 'active',
            systemDefault: {
              hasAuth: true,
              authKind: 'oauth',
              email: 'cli@example.test',
              providerAccountId: 'cli',
              workspaceLabel: null
            }
          },
          rateLimits: null
        },
        accountsVerified: true,
        ownerRateLimits: createEmptyRateLimitState({ codex, claude }),
        anyFetching: false,
        anyVisible: true,
        barRef: ref,
        canSignInFromUsageRow: () => false,
        collapseUsage: false,
        collapsedUsageProviders: [],
        compact: true,
        floatingTerminalActionLabel: '',
        floatingTerminalShortcut: '',
        handleManageAccounts: vi.fn(),
        handleOpenProviderAccounts: vi.fn(),
        handleRefresh: vi.fn(),
        handleUsageDetails: vi.fn(),
        handleUsageMenuOpenChange: setUsageMenuOpen,
        hasVisibleUsageMeters: true,
        hasPinnedUsage: false,
        isEmptyUsageState: false,
        isRefreshing: false,
        overflowing: false,
        petEnabled: false,
        remoteOwner: { environmentId: 'synthetic-host', label: 'Synthetic host' },
        rosterProviders: [claude, codex],
        segmentsIconOnly: false,
        segmentsRef: ref,
        setMenuOpen: vi.fn(),
        setMenuPoint: vi.fn(),
        setStatusBarUsageMode: vi.fn(),
        showEmptyUsageCta: false,
        showFloatingTerminalToggle: false,
        showFloatingWorkspaceAttentionDot: false,
        showPorts: false,
        showResourceUsage: false,
        showSsh: false,
        statusBarUsageMode: 'compact',
        usageMenuFocusHandoff: { onPointerDownOutside: vi.fn(), onCloseAutoFocus: vi.fn() },
        usageMenuOpen,
        usagePercentageDisplay: 'used',
        usageRef: ref,
        usageTightestOnly: false
      }
    }
  }
})
vi.mock('./UsagePinnedAccounts', () => ({
  UsagePinnedAccounts: ({ fallback }: { fallback: React.ReactNode }) => fallback
}))
vi.mock('./use-usage-account-pools', () => ({
  useUsageAccountPools: () => ({ view: null, verified: false })
}))
vi.mock('./UsageCodexAccountRows', async () => {
  const { UsageAccountRows } = await import('./UsageAccountRows')
  return {
    UsageCodexAccountRows: ({
      now,
      display,
      mode,
      onManageProvider
    }: {
      now: number
      display: 'used'
      mode: 'compact'
      onManageProvider: () => void
    }) => (
      <UsageAccountRows
        provider="codex"
        now={now}
        display={display}
        mode={mode}
        onManageProvider={onManageProvider}
        onSelectAccount={mocks.select}
      />
    )
  }
})
vi.mock('./ClaudeSwitcherMenu', async () => {
  const { DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuItem } =
    await import('@/components/ui/dropdown-menu')
  return {
    ClaudeSwitcherMenu: ({ triggerContent }: { triggerContent: React.ReactNode }) => (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>{triggerContent}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onSelect={() => mocks.select('claude')}>
            Choose Claude account
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => mocks.select('wsl')}>
            Claude WSL runtime
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }
})
vi.mock('./CodexSwitcherMenu', async () => {
  const { DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuItem } =
    await import('@/components/ui/dropdown-menu')
  return {
    CodexSwitcherMenu: ({ triggerContent }: { triggerContent: React.ReactNode }) => (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>{triggerContent}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onSelect={() => mocks.select(null)}>
            Use Codex CLI login
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => mocks.select('wsl')}>
            Codex WSL runtime
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }
})
vi.mock('./StatusBarUsageChangeNotices', () => ({
  StatusBarUsageChangeNotices: ({ children }: { children: React.ReactNode }) => children
}))
vi.mock('./CaffeinateStatusSegment', () => ({ CaffeinateStatusSegment: () => null }))
vi.mock('./RemoteServerUpdateStatusSegment', () => ({
  RemoteServerUpdateStatusSegment: () => null
}))
vi.mock('./SkillUpdateStatusSegment', () => ({ SkillUpdateStatusSegment: () => null }))
vi.mock('./NativeChatResumeStatusSegment', () => ({ NativeChatResumeStatusSegment: () => null }))
vi.mock('./UpdateStatusSegment', () => ({ UpdateStatusSegment: () => null }))
vi.mock('./StatusBarVisibilityMenu', () => ({ StatusBarVisibilityMenu: () => null }))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original()),
  runtimeEnvironmentSupportsCapability: async () => true,
  callRuntimeRpc: mocks.resetRpc
}))

import { StatusBarSurface } from './StatusBarSurface'

afterEach(() => {
  cleanup()
  mocks.select.mockReset()
  mocks.resetRpc.mockReset()
  useAppStore.setState({ statusBarAccountPins: [] })
})

it('keeps flat account actions reachable from the production Usage trigger and returns focus on Escape', async () => {
  useAppStore.setState({
    statusBarAccountPins: [],
    setStatusBarAccountPins: (pins) => useAppStore.setState({ statusBarAccountPins: pins })
  })
  const user = userEvent.setup()
  render(
    <TooltipProvider>
      <StatusBarSurface floatingTerminalOpen={false} />
    </TooltipProvider>
  )
  const trigger = screen.getByRole('button', { name: 'Usage' })
  trigger.focus()
  await user.keyboard('{Enter}')
  const row = await screen.findByRole('group', { name: 'Codex active@example.test usage' })
  expect(
    screen.getByRole('group', { name: 'Codex CLI login on this host · cli@example.test usage' })
      .textContent
  ).not.toContain('Saved profile')
  expect(screen.getByText('Synthetic host')).toBeTruthy()
  expect(screen.getAllByText('Codex · Switch account or runtime')).toHaveLength(1)
  expect(screen.getAllByText('Claude · Switch account or runtime')).toHaveLength(1)
  expect(screen.queryByText('Profiles are separate sign-in contexts')).toBeNull()

  const rowButton = row.querySelector('button[aria-expanded]')
  if (!rowButton) throw new Error('Missing account row trigger')
  for (let step = 0; step < 5 && document.activeElement !== rowButton; step++) {
    await user.keyboard('{ArrowDown}')
  }
  expect(document.activeElement).toBe(rowButton)
  await user.keyboard('{Enter}')
  expect(rowButton.getAttribute('aria-expanded')).toBe('true')
  if (process.env.OPKA_SYNTHETIC_EVIDENCE_DIR) {
    const panel = document.querySelector('[data-slot="dropdown-menu-content"] > div')
    if (!panel) throw new Error('Missing production Usage panel')
    writeFileSync(
      join(process.env.OPKA_SYNTHETIC_EVIDENCE_DIR, 'review-actions.html'),
      `<html><head><meta charset="utf-8"><link rel="stylesheet" href="review-actions.css"></head><body><main style="width:360px;margin:48px auto;border:1px solid #ddd;background:#fff">${panel.outerHTML}</main></body></html>`
    )
  }
  await user.keyboard('{Tab}')
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Pin active@example.test to status bar' })
  )
  await user.keyboard('{Enter}')
  expect(useAppStore.getState().statusBarAccountPins).toHaveLength(1)
  expect(screen.queryByText(/Pinned status bar accounts/)).toBeNull()

  await user.keyboard('{Tab}{Tab}')
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Use reset' }))
  await user.keyboard('{Enter}')
  expect(screen.getByRole('dialog').textContent).toContain('active@example.test')
  expect(mocks.resetRpc).not.toHaveBeenCalled()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()

  const codexActions = screen.getByText('Codex · Switch account or runtime')
  const codexMenuItem = codexActions.closest('[role="menuitem"]')
  if (!(codexMenuItem instanceof HTMLElement)) throw new Error('Missing Codex menu item')
  codexMenuItem.focus()
  await user.keyboard('{ArrowRight}')
  await user.click(await screen.findByText('Use Codex CLI login'))
  expect(mocks.select).toHaveBeenCalledWith(null)
  trigger.focus()
  await user.keyboard('{Enter}')
  const claudeActions = screen.getByText('Claude · Switch account or runtime')
  const claudeMenuItem = claudeActions.closest('[role="menuitem"]')
  if (!(claudeMenuItem instanceof HTMLElement)) throw new Error('Missing Claude menu item')
  claudeMenuItem.focus()
  await user.keyboard('{ArrowRight}')
  const claudeAccount = (await screen.findByText('Choose Claude account')).closest(
    '[role="menuitem"]'
  )
  if (!(claudeAccount instanceof HTMLElement)) throw new Error('Missing Claude account item')
  claudeAccount.focus()
  await user.keyboard('{Enter}')
  expect(mocks.select).toHaveBeenCalledWith('claude')
  trigger.focus()
  await user.keyboard('{Enter}')
  await user.keyboard('{Escape}')
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  expect(mocks.resetRpc).not.toHaveBeenCalled()
})
