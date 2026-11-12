// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GITLAB_NATIVE_PROFILE_IMPORT_RUNTIME_CAPABILITY } from '../../../../shared/gitlab-network-profile'
import { RemoteGlabProfileImport } from './RemoteGlabProfileImport'

const { status, rpc } = vi.hoisted(() => ({ status: vi.fn(), rpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  getRuntimeEnvironmentStatus: status,
  callRuntimeRpc: rpc
}))

afterEach(cleanup)
beforeEach(() => {
  status.mockReset().mockResolvedValue({
    runtimeId: 'owner-epoch',
    capabilities: [GITLAB_NATIVE_PROFILE_IMPORT_RUNTIME_CAPABILITY]
  })
  rpc.mockReset().mockResolvedValue({
    id: 'a'.repeat(64),
    host: 'gitlab.example.com',
    user: 'alice',
    generation: '00000000-0000-4000-8000-000000000001'
  })
})

it('imports only from the selected owning runtime and returns a bindable profile', async () => {
  const onImported = vi.fn()
  render(
    <RemoteGlabProfileImport
      runtimeEnvironmentId="owner-host"
      host="gitlab.example.com"
      disabled={false}
      onImported={onImported}
    />
  )
  const button = await screen.findByRole('button', { name: /Use this host’s glab login/ })
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  fireEvent.click(button)
  await waitFor(() => expect(onImported).toHaveBeenCalledOnce())
  expect(rpc).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'owner-host' },
    'gitlab.importNativeNetworkProfile',
    { host: 'gitlab.example.com' },
    { expectedEnvironmentRuntimeId: 'owner-epoch' }
  )
  expect(onImported.mock.calls[0][0]).toMatchObject({ host: 'gitlab.example.com', user: 'alice' })
})

it('does not call an older runtime that lacks import capability', async () => {
  status.mockResolvedValue({ runtimeId: 'old-epoch', capabilities: [] })
  render(
    <RemoteGlabProfileImport
      runtimeEnvironmentId="old-host"
      host="gitlab.example.com"
      disabled={false}
      onImported={vi.fn()}
    />
  )
  expect(await screen.findByText(/Update or reconnect this execution host/)).toBeTruthy()
  expect(
    screen.getByRole('button', { name: /Use this host’s glab login/ }).hasAttribute('disabled')
  ).toBe(true)
  expect(rpc).not.toHaveBeenCalled()
})

it('ignores an old import result after the selected host changes', async () => {
  let release: ((value: unknown) => void) | undefined
  rpc.mockReturnValue(
    new Promise((resolve) => {
      release = resolve
    })
  )
  const onImported = vi.fn()
  const view = render(
    <RemoteGlabProfileImport
      runtimeEnvironmentId="owner-host"
      host="gitlab.example.com"
      disabled={false}
      onImported={onImported}
    />
  )
  const button = await screen.findByRole('button', { name: /Use this host’s glab login/ })
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  fireEvent.click(button)
  await waitFor(() => expect(rpc).toHaveBeenCalledOnce())
  view.rerender(
    <RemoteGlabProfileImport
      runtimeEnvironmentId="another-host"
      host="another.example.com"
      disabled={false}
      onImported={onImported}
    />
  )
  await act(async () => {
    release?.({
      id: 'a'.repeat(64),
      host: 'gitlab.example.com',
      user: 'alice',
      generation: '00000000-0000-4000-8000-000000000001'
    })
  })
  await waitFor(() => expect(status).toHaveBeenCalledWith('another-host'))
  expect(onImported).not.toHaveBeenCalled()
})
