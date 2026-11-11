// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CodexResetCreditExpectedScope } from '../../../shared/codex-reset-credit-scope'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { createEmptyRateLimitState } from '../../../shared/rate-limit-state-factory'
import { CodexResetCreditControl } from './codex-reset-credit-control'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  capability: vi.fn(),
  setState: vi.fn(),
  getState: vi.fn(),
  success: vi.fn(),
  error: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  runtimeEnvironmentSupportsCapability: mocks.capability
}))
vi.mock('../store', () => ({ useAppStore: { setState: mocks.setState, getState: mocks.getState } }))
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
  const offer = limits(count)
  mocks.getState.mockReturnValue({ rateLimits: { codex: offer } })
  return (
    <CodexResetCreditControl
      account={account}
      limits={offer}
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
  mocks.getState.mockReset()
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

  it('disables a newly expired credit before the minute tick and refuses an expired confirmation', () => {
    const initial = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(initial)
    try {
      const offer = limits(2)
      const view = render(
        <CodexResetCreditControl
          account={account}
          limits={offer}
          rateLimitTarget={target}
          owner={local}
          ownerLabel="Desk"
          verified
        />
      )
      clock.mockReturnValue(initial + 20_000)
      view.rerender(
        <CodexResetCreditControl
          account={account}
          limits={{
            ...offer,
            updatedAt: initial + 20_000,
            rateLimitResetCredits: { availableCount: 2, nextExpiresAt: initial + 19_000 }
          }}
          rateLimitTarget={target}
          owner={local}
          ownerLabel="Desk"
          verified
        />
      )
      expect(screen.getByRole('button', { name: 'Use reset' }).hasAttribute('disabled')).toBe(true)
      view.unmount()

      clock.mockReturnValue(initial)
      const later = {
        ...limits(2),
        rateLimitResetCredits: { availableCount: 2, nextExpiresAt: initial + 1_000 }
      }
      mocks.getState.mockReturnValue({ rateLimits: { codex: later } })
      render(
        <CodexResetCreditControl
          account={account}
          limits={later}
          rateLimitTarget={target}
          owner={local}
          ownerLabel="Desk"
          verified
        />
      )
      const confirmation = confirm()
      clock.mockReturnValue(initial + 2_000)
      fireEvent.click(confirmation)
      expect(mocks.call).not.toHaveBeenCalled()
    } finally {
      clock.mockRestore()
    }
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

  it.each(['account', 'wsl', 'newer', 'unmount'])(
    'does not apply a late %s reply',
    async (change) => {
      let settle: (value: unknown) => void = () => {}
      mocks.call.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = resolve
          })
      )
      const view = render(control(2))
      fireEvent.click(confirm())
      await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
      if (change === 'unmount') {
        view.unmount()
      } else if (change === 'account') {
        view.rerender(
          <CodexResetCreditControl
            account={{ ...account, id: 'account-two', email: 'two@example.test' }}
            limits={{ ...limits(2), usageMetadata: { authProvenance: 'profile:account-two' } }}
            rateLimitTarget={target}
            owner={local}
            ownerLabel="Desk"
            verified
          />
        )
      } else if (change === 'wsl') {
        view.rerender(
          <CodexResetCreditControl
            account={{ ...account, managedHomeRuntime: 'wsl', wslDistro: 'Ubuntu' }}
            limits={{
              ...limits(2),
              usageMetadata: { authProvenance: 'profile:account-one:wsl:Ubuntu' }
            }}
            rateLimitTarget={{ runtime: 'wsl', wslDistro: 'Ubuntu' }}
            owner={local}
            ownerLabel="Desk"
            verified
          />
        )
      } else {
        view.rerender(control(1))
      }
      const expectedScope = mocks.call.mock.calls[0]?.[2].expectedScope
      await act(async () =>
        settle({
          outcome: 'reset',
          scope: expectedScope,
          snapshot: { rateLimits: { codex: limits(1) } }
        })
      )
      expect(mocks.setState).not.toHaveBeenCalled()
    }
  )

  it('keeps a newer store quota that arrives before React re-renders', async () => {
    const offer = limits(2)
    let store = { ...createEmptyRateLimitState(), codex: offer }
    mocks.getState.mockReturnValue({ rateLimits: store })
    mocks.setState.mockImplementation((update) => {
      store = update({ rateLimits: store }).rateLimits
    })
    let settle: (value: unknown) => void = () => {}
    mocks.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    render(
      <CodexResetCreditControl
        account={account}
        limits={offer}
        rateLimitTarget={target}
        owner={local}
        ownerLabel="Desk"
        verified
      />
    )
    fireEvent.click(confirm())
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    store = { ...store, codex: limits(3) }
    const expectedScope = mocks.call.mock.calls[0]?.[2].expectedScope
    await act(async () =>
      settle({
        outcome: 'reset',
        scope: expectedScope,
        snapshot: { rateLimits: { ...createEmptyRateLimitState(), codex: limits(1) } }
      })
    )
    expect(store.codex?.rateLimitResetCredits?.availableCount).toBe(3)
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith(
      'Quota changed while the reset was pending',
      expect.anything()
    )
  })
})
