// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GITLAB_NATIVE_PROFILE_IMPORT_RUNTIME_CAPABILITY } from '../../../../shared/gitlab-network-profile'
import { CloneNetworkAccountPicker } from './CloneNetworkAccountPicker'

const { rpc, status } = vi.hoisted(() => ({ rpc: vi.fn(), status: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc,
  getRuntimeEnvironmentStatus: status
}))
vi.mock('./CloneGitLabProfileDialog', () => ({ CloneGitLabProfileDialog: () => null }))
vi.mock('./CloneGitLabProfileRemovalDialog', () => ({
  CloneGitLabProfileRemovalDialog: () => null
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.currentTarget.value)}>
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

afterEach(cleanup)
beforeEach(() => {
  status.mockReset().mockResolvedValue({
    runtimeId: 'owner-epoch',
    capabilities: [GITLAB_NATIVE_PROFILE_IMPORT_RUNTIME_CAPABILITY]
  })
  rpc.mockReset().mockImplementation(async (_target, method) =>
    method === 'gitlab.listNetworkProfiles'
      ? []
      : {
          id: 'a'.repeat(64),
          host: 'gitlab.example.com',
          user: 'alice',
          generation: '00000000-0000-4000-8000-000000000001'
        }
  )
})

it('adds the owning host imported profile to clone choices without a client token', async () => {
  const onSelect = vi.fn()
  render(
    <CloneNetworkAccountPicker
      url="https://gitlab.example.com/group/repo.git"
      runtimeEnvironmentId="owner-host"
      selected={null}
      onSelect={onSelect}
      onModeChange={vi.fn()}
      disabled={false}
    />
  )
  const provider = document.querySelector('select')
  if (!provider) {
    throw new Error('Provider select missing')
  }
  fireEvent.change(provider, { target: { value: 'gitlab' } })
  const importButton = await screen.findByRole('button', { name: /Use this host’s glab login/ })
  await waitFor(() => expect(importButton.hasAttribute('disabled')).toBe(false))
  fireEvent.click(importButton)
  await waitFor(() =>
    expect(onSelect).toHaveBeenCalledWith({ provider: 'gitlab', profileId: 'a'.repeat(64) })
  )
  expect(rpc).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'owner-host' },
    'gitlab.importNativeNetworkProfile',
    { host: 'gitlab.example.com' },
    { expectedEnvironmentRuntimeId: 'owner-epoch' }
  )
  expect(screen.getByText('alice · gitlab.example.com')).toBeTruthy()
})
