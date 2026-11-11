// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloneNetworkAccountPicker } from './CloneNetworkAccountPicker'

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    disabled?: boolean
    children: React.ReactNode
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))
vi.mock('./CloneGitLabProfileDialog', () => ({
  CloneGitLabProfileDialog: ({ open, ownerKey }: { open: boolean; ownerKey: string }) => (
    <div data-testid="profile-dialog-state">{`${ownerKey}:${open ? 'open' : 'closed'}`}</div>
  )
}))

afterEach(() => cleanup())

describe('clone account picker owner lifetime', () => {
  it('closes a local add intent when the execution owner changes with the same URL', () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        gl: { listNetworkProfiles: vi.fn(async () => []), provisionNetworkProfile: vi.fn() },
        gh: { listCloneAccounts: vi.fn() }
      }
    })
    const props = {
      url: 'https://gitlab.example/team/repo.git',
      selected: null,
      onSelect: vi.fn(),
      onModeChange: vi.fn(),
      disabled: false
    }
    const view = render(<CloneNetworkAccountPicker {...props} runtimeEnvironmentId={null} />)
    const providerSelect = screen.getAllByRole('combobox')[0]
    fireEvent.change(providerSelect, { target: { value: 'gitlab' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add verified GitLab profile' }))
    expect(screen.getByTestId('profile-dialog-state').textContent).toBe(
      'local\0gitlab.example:open'
    )
    view.rerender(<CloneNetworkAccountPicker {...props} runtimeEnvironmentId="paired-b" />)
    expect(screen.getByTestId('profile-dialog-state').textContent).toBe(
      'paired-b\0gitlab.example:closed'
    )
  })
})
