// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountPoolMemberSettings } from './AccountPoolMemberSettings'

const member = {
  accountId: 'owned-account',
  priority: 2,
  weight: 3,
  role: 'reserve' as const,
  state: 'draining' as const,
  maxConcurrent: 4,
  cooldownUntil: 12345
}
afterEach(cleanup)
it('edits balanced weight without discarding reserve role, drain or ownership', () => {
  const onChange = vi.fn()
  const { rerender } = render(
    <AccountPoolMemberSettings
      member={member}
      accountLabel="Account"
      balanced
      disabled={false}
      onChange={onChange}
    />
  )
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Account weight' }), {
    target: { value: '7' }
  })
  expect(onChange).toHaveBeenLastCalledWith({ ...member, weight: 7 })
  onChange.mockClear()
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Account weight' }), {
    target: { value: '101' }
  })
  expect(onChange).not.toHaveBeenCalled()
  rerender(
    <AccountPoolMemberSettings
      member={member}
      accountLabel="Account"
      balanced={false}
      disabled
      onChange={onChange}
    />
  )
  expect(screen.queryByRole('spinbutton', { name: 'Account weight' })).toBeNull()
  expect(
    screen.getByRole('spinbutton', { name: 'Account priority' }).hasAttribute('disabled')
  ).toBe(true)
  expect(screen.getByRole('combobox', { name: 'Account pool role' }).hasAttribute('disabled')).toBe(
    true
  )
})
