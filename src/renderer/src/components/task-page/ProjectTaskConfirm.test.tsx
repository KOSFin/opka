// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectTaskConfirm } from './ProjectTaskConfirm'

afterEach(cleanup)

it('opens and accepts from the keyboard, and lets Escape cancel without a second decision', async () => {
  const user = userEvent.setup()
  const run = vi.fn(async (_reason: string) => {})
  function Task() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button onClick={() => setOpen(true)}>Accept result</button>
        <ProjectTaskConfirm
          action={
            open
              ? {
                  title: 'Accept reviewed result',
                  description: 'Task under review',
                  reason: 'optional',
                  focusConfirm: true,
                  run
                }
              : null
          }
          onClose={() => setOpen(false)}
        />
      </>
    )
  }
  render(<Task />)
  await user.tab()
  await user.keyboard('{Enter}')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus())
  await user.keyboard('{Enter}')
  expect(run).toHaveBeenCalledExactlyOnceWith('')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Accept result' })).toHaveFocus())
  await user.keyboard('{Enter}')
  await screen.findByRole('dialog')
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(run).toHaveBeenCalledTimes(1)
})
