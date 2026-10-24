// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MacBetaUpdateContent } from './MacBetaUpdateContent'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
afterEach(cleanup)
it.each([false, true])('names the actual beta action (downloaded: %s)', (downloaded) => {
  const onAction = vi.fn()
  const onClose = vi.fn()
  render(
    <MacBetaUpdateContent
      version="0.1.0-rc.1"
      downloaded={downloaded}
      onAction={onAction}
      onClose={onClose}
    />
  )
  expect(onAction).not.toHaveBeenCalled()
  fireEvent.click(
    screen.getByRole('button', { name: downloaded ? 'Open installer' : 'Download installer' })
  )
  expect(onAction).toHaveBeenCalledOnce()
  expect(screen.queryByText('Restart to Update')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss update' }))
  expect(onClose).toHaveBeenCalledOnce()
})
