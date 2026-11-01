// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { StatusBarAccountPin } from '../../../../shared/status-bar-account-pins'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import { UsagePinnedAccounts } from './UsagePinnedAccounts'
import { UsageAccountPinButton } from './UsageAccountPinButton'
const mocks = vi.hoisted(() => {
  const pins: unknown[] = []
  return { pins, setPins: vi.fn() }
})
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: null,
      statusBarAccountPins: mocks.pins,
      setStatusBarAccountPins: mocks.setPins
    })
}))
const pin: StatusBarAccountPin = {
  owner: 'local',
  provider: 'codex',
  runtimeKey: 'host',
  accountId: 'one',
  label: 'One'
}
afterEach(() => {
  cleanup()
  mocks.pins = []
  vi.resetAllMocks()
})
it('pinning is an explicit display preference change without runtime selection', () => {
  const view = render(<UsageAccountPinButton pin={pin} />)
  fireEvent.click(screen.getByRole('button', { name: 'Pin One to status bar' }))
  expect(mocks.setPins).toHaveBeenCalledWith([pin])
  mocks.pins = [pin]
  view.rerender(<UsageAccountPinButton pin={pin} />)
  fireEvent.click(screen.getByRole('button', { name: 'Unpin One from status bar' }))
  expect(mocks.setPins).toHaveBeenLastCalledWith([])
})
it('shows at most three unknown chips with overflow and restores contextual display on owner switch', () => {
  mocks.pins = Array.from({ length: 8 }, (_, index) => ({
    ...pin,
    accountId: String(index),
    label: `Account ${index}`
  }))
  const props = {
    snapshot: null,
    limits: createEmptyRateLimitState(),
    verified: false,
    display: 'used' as const,
    fallback: <span>Provider summary</span>
  }
  const view = render(<UsagePinnedAccounts {...props} target={{ kind: 'local' }} />)
  expect(screen.queryByText('Provider summary')).toBeNull()
  expect(screen.getByText('+5')).toBeTruthy()
  expect(screen.getAllByLabelText(/Account unavailable/)).toHaveLength(3)
  view.rerender(
    <UsagePinnedAccounts {...props} target={{ kind: 'environment', environmentId: 'other' }} />
  )
  expect(screen.getByText('Provider summary')).toBeTruthy()
})
