// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CodexResetCreditExpectedScope } from '../../../shared/codex-reset-credit-scope'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { CodexResetCreditControl } from './codex-reset-credit-control'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  capability: vi.fn(),
  setState: vi.fn(),
  success: vi.fn(),
  error: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  runtimeEnvironmentSupportsCapability: mocks.capability
}))
vi.mock('../store', () => ({ useAppStore: { setState: mocks.setState } }))
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }))
vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => '11111111-1111-4111-8111-111111111111'
}))

const account = {
  id: 'account-one',
  email: 'one@example.test',
  managedHomeRuntime: 'host' as const,
  wslDistro: null,
  createdAt: 1,
  updatedAt: 10,
  lastAuthenticatedAt: 10
}
const target = { runtime: 'host' as const, wslDistro: null }
const local = { kind: 'local' as const }

function limits(count: number): ProviderRateLimits {
  return {
    provider: 'codex',
    session: {
      usedPercent: 100,
      windowMinutes: 300,
      resetsAt: Date.now() + 60_000,
      resetDescription: null
    },
    weekly: null,
    rateLimitResetCredits: { availableCount: count, nextExpiresAt: Date.now() + 3_600_000 },
    usageMetadata: { authProvenance: 'profile:account-one' },
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

function control(count: number, owner: RuntimeClientTarget = local) {
  return (
    <CodexResetCreditControl
      account={account}
      limits={limits(count)}
      rateLimitTarget={target}
      owner={owner}
      ownerLabel="Desk"
      verified
    />
  )
}

function confirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Use reset' }))
  expect(screen.getByRole('dialog').textContent).toContain('one@example.test on Desk')
  return within(screen.getByRole('dialog')).getByRole('button', { name: 'Use reset' })
}

beforeEach(() => {
  mocks.call.mockReset()
  mocks.capability.mockReset().mockResolvedValue(true)
  mocks.setState.mockReset()
  mocks.success.mockReset()
  mocks.error.mockReset()
})
afterEach(cleanup)

describe('CodexResetCreditControl synthetic adapter', () => {
  it('shows zero credits but cannot submit', () => {
    render(control(0))
    expect(screen.getByText(/0 manual resets available/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Use reset' }).hasAttribute('disabled')).toBe(true)
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('does not offer another account’s quota or stale usage', () => {
    const otherQuota = { ...limits(2), usageMetadata: { authProvenance: 'profile:account-two' } }
    const view = render(
      <CodexResetCreditControl
        account={account}
        limits={otherQuota}
        rateLimitTarget={target}
        owner={local}
        ownerLabel="Desk"
        verified
      />
    )
    expect(screen.getByRole('button', { name: 'Use reset' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/Account quota unverified/)).toBeTruthy()
    view.rerender(
      <CodexResetCreditControl
        account={account}
        limits={{ ...limits(2), updatedAt: 1 }}
        rateLimitTarget={target}
        owner={local}
        ownerLabel="Desk"
        verified
      />
    )
    expect(screen.getByRole('button', { name: 'Use reset' }).hasAttribute('disabled')).toBe(true)
  })

  it('cancels without a mutation and updates 2 to 1 after a confirmed result', async () => {
    const view = render(control(2))
    confirm()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(mocks.call).not.toHaveBeenCalled()
    const confirmation = confirm()
    mocks.call.mockImplementationOnce(
      (_owner, _method, params: { expectedScope: CodexResetCreditExpectedScope }) =>
        Promise.resolve({
          outcome: 'reset',
          scope: params.expectedScope,
          snapshot: { rateLimits: { codex: limits(1) } }
        })
    )
    fireEvent.click(confirmation)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.setState).toHaveBeenCalledTimes(1))
    expect(mocks.call.mock.calls[0]?.[2].expectedScope.accountId).toBe('account-one')
    view.rerender(control(1))
    expect(screen.getByText(/1 manual reset available/)).toBeTruthy()
  })

  it('holds one in-flight request after a double click and reports an uncertain outcome', async () => {
    mocks.call.mockRejectedValueOnce(new Error('Connection lost'))
    render(control(2))
    const confirmation = confirm()
    fireEvent.click(confirmation)
    fireEvent.click(confirmation)
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('Reset outcome needs review', expect.anything())
    )
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('does not send a pinned confirmation to another host', async () => {
    const view = render(control(2))
    confirm()
    view.rerender(control(2, { kind: 'environment', environmentId: 'host-two' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mocks.call).not.toHaveBeenCalled()
  })
})
