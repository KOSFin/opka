// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeCliShellSetupControl } from './NativeCliShellSetupControl'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
const missing = { supported: true, state: 'not-installed', missing: [] } as const
const ready = { supported: true, state: 'installed', missing: [] } as const
const target = { kind: 'environment', environmentId: 'server-a' } as const
const done = vi.fn()
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
it('installs once only on click, including StrictMode, and refreshes once after the host result', async () => {
  let finish: (value: unknown) => void = () => {}
  rpc.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  render(
    <StrictMode>
      <NativeCliShellSetupControl
        setup={{ ...missing, missing: [] }}
        target={target}
        hostLabel="Build server"
        onComplete={done}
      />
    </StrictMode>
  )
  expect(rpc).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Set up ordinary CLI' }))
  fireEvent.click(screen.getByRole('button', { name: 'Setting up…' }))
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(rpc.mock.calls[0].slice(0, 3)).toEqual([
    target,
    'accounts.installNativeCliIntegration',
    undefined
  ])
  expect(screen.getByRole('status').textContent).toContain('Build server')
  finish(ready)
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('button', { name: 'Remove CLI setup' })).toBeTruthy()
})
it('suppresses old-host completion and preserves review/missing/unsupported states without force', async () => {
  let finish: (value: unknown) => void = () => {}
  rpc.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const view = render(
    <NativeCliShellSetupControl
      setup={{ ...missing, missing: [] }}
      target={target}
      hostLabel="First"
      onComplete={done}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Set up ordinary CLI' }))
  view.rerender(
    <NativeCliShellSetupControl
      setup={{ supported: true, state: 'modified', missing: [] }}
      target={{ kind: 'environment', environmentId: 'second' }}
      hostLabel="Second"
      onComplete={done}
    />
  )
  finish(ready)
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Second'))
  expect(done).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Remove CLI setup' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Set up ordinary CLI' })).toBeNull()
  expect(screen.getByText(/agent native-shell status/)).toBeTruthy()
})
it('removes setup explicitly, keeps errors private, and does not auto retry', async () => {
  rpc.mockRejectedValue(new Error('/private/host/profile is not safe'))
  render(
    <NativeCliShellSetupControl
      setup={{ ...ready, missing: [] }}
      target={target}
      hostLabel="Server"
      onComplete={done}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Remove CLI setup' }))
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
  expect(rpc.mock.calls[0][1]).toBe('accounts.uninstallNativeCliIntegration')
  expect(screen.getByRole('status').textContent).toContain('could not be confirmed')
  expect(screen.getByRole('status').textContent).not.toContain('/private/')
  expect(rpc).toHaveBeenCalledTimes(1)
})
it('disables setup until all prerequisites are available and shows no force action', () => {
  const view = render(
    <NativeCliShellSetupControl
      setup={{ ...missing, missing: ['codex'] }}
      target={target}
      hostLabel="Server"
      onComplete={done}
    />
  )
  expect(screen.queryByRole('button', { name: 'Set up ordinary CLI' })).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('codex')
  view.rerender(
    <NativeCliShellSetupControl
      setup={{ supported: false, state: 'unsupported', missing: [] }}
      target={target}
      hostLabel="Server"
      onComplete={done}
    />
  )
  expect(screen.queryByRole('button')).toBeNull()
  expect(rpc).not.toHaveBeenCalled()
})
