// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProviderAccountsDisclosure } from './ProviderAccountsDisclosure'

afterEach(cleanup)

it('starts collapsed and reveals Add account within its provider section', () => {
  render(
    <ProviderAccountsDisclosure title="Codex" icon={<span />} searchQuery="">
      <button>Add Codex account</button>
    </ProviderAccountsDisclosure>
  )
  const section = screen.getByRole('button', { name: 'Codex' })
  expect(section.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('button', { name: 'Add Codex account' })).toBeNull()
  fireEvent.click(section)
  expect(section.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('button', { name: 'Add Codex account' })).toBeTruthy()
})

it('opens a matching section during account search', () => {
  render(
    <ProviderAccountsDisclosure title="Claude" icon={<span />} searchQuery="profile">
      <button>Add Claude account</button>
    </ProviderAccountsDisclosure>
  )
  expect(screen.getByRole('button', { name: 'Add Claude account' })).toBeTruthy()
})
