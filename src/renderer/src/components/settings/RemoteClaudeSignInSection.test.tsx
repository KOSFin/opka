// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('../ui/select', async () => {
  const React = await import('react')
  const Context = React.createContext<{ onValueChange?: (value: string) => void }>({})
  return {
    Select: ({
      onValueChange,
      children
    }: {
      onValueChange: (value: string) => void
      children: React.ReactNode
    }) => {
      const value = React.useMemo(() => ({ onValueChange }), [onValueChange])
      return <Context.Provider value={value}>{children}</Context.Provider>
    },
    SelectTrigger: ({ children, ...props }: React.ComponentProps<'button'>) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const { onValueChange } = React.useContext(Context)
      return (
        <button type="button" onClick={() => onValueChange?.(value)}>
          {children}
        </button>
      )
    }
  }
})
import { RemoteClaudeSignInSection } from './RemoteClaudeSignInSection'
const target = { kind: 'environment', environmentId: 'server-one' } as const
const inventory = {
  worktrees: [
    { id: 'folder:project', displayName: 'Project', path: '/test' },
    { id: 'copy-two', displayName: 'Second copy', path: '/test-two' }
  ]
}
const receipt = {
  terminal: {
    handle: 'term-test',
    worktreeId: 'copy-two',
    tabId: 'tab-test',
    leafId: 'leaf-test',
    executionHostId: 'runtime:server-one'
  }
}
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
async function choose() {
  fireEvent.click(screen.getByRole('button', { name: 'Add Claude account in terminal' }))
  await screen.findByRole('button', { name: 'Second copy' })
  fireEvent.click(screen.getByRole('button', { name: 'Second copy' }))
  fireEvent.click(screen.getByRole('button', { name: 'Open Claude sign-in' }))
}
it('opens sign-in on the exact selected server and reveals that server terminal locally', async () => {
  rpc.mockResolvedValueOnce(inventory).mockResolvedValueOnce(receipt).mockResolvedValueOnce({})
  render(<RemoteClaudeSignInSection target={target} />)
  await choose()
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith({ kind: 'local' }, 'terminal.reveal', {
      worktreeId: 'copy-two',
      tabId: 'tab-test',
      leafId: 'leaf-test',
      executionHostId: 'runtime:server-one'
    })
  )
  expect(rpc).toHaveBeenCalledWith(target, 'worktree.list', { limit: 100 })
  expect(rpc).toHaveBeenCalledWith(target, 'accounts.openSignInTerminal', {
    provider: 'claude',
    worktree: 'id:copy-two',
    clientMutationId: expect.any(String)
  })
})
it('reuses the same mutation identifier after a transport failure', async () => {
  rpc
    .mockResolvedValueOnce(inventory)
    .mockRejectedValueOnce(new Error('Connection timed out'))
    .mockResolvedValueOnce(receipt)
    .mockResolvedValueOnce({})
  render(<RemoteClaudeSignInSection target={target} />)
  await choose()
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Open Claude sign-in' }))
  await waitFor(() =>
    expect(
      rpc.mock.calls.filter(([, method]) => method === 'accounts.openSignInTerminal')
    ).toHaveLength(2)
  )
  const calls = rpc.mock.calls.filter(([, method]) => method === 'accounts.openSignInTerminal')
  expect(calls[1]).toEqual(calls[0])
})
it('does not reveal a terminal after its host section has been removed', async () => {
  let reply: (value: unknown) => void = () => {
    throw new Error('not pending')
  }
  rpc.mockResolvedValueOnce(inventory).mockReturnValueOnce(
    new Promise((resolve) => {
      reply = resolve
    })
  )
  const view = render(<RemoteClaudeSignInSection target={target} />)
  await choose()
  view.unmount()
  reply(receipt)
  await Promise.resolve()
  expect(rpc.mock.calls.some(([, method]) => method === 'terminal.reveal')).toBe(false)
})
