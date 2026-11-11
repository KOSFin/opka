// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FileExplorerLocationBar } from './FileExplorerLocationBar'

afterEach(cleanup)

it('offers keyboard-accessible path segments and tells the user scope leaves terminal cwd unchanged', () => {
  const onSelectRoot = vi.fn()
  const onBack = vi.fn()
  render(
    <TooltipProvider>
      <FileExplorerLocationBar
        rootChoice="src/nested"
        rootName="Project"
        canGoBack
        canGoForward={false}
        onBack={onBack}
        onForward={vi.fn()}
        onUp={vi.fn()}
        onSelectRoot={onSelectRoot}
        disabled={false}
      />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(onBack).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: 'Forward' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'src' }))
  expect(onSelectRoot).toHaveBeenCalledWith('src')
  fireEvent.click(screen.getByRole('button', { name: 'Project' }))
  expect(onSelectRoot).toHaveBeenCalledWith('/')
  expect(screen.getByText(/terminal cwd unchanged/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'nested' }).getAttribute('aria-current')).toBe('page')
})
