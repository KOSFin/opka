import { expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ available: true, status: vi.fn() }))
vi.mock('./configure-native-cli-user-integration', () => ({
  getRuntimeNativeCliUserIntegration: () => (state.available ? state : null)
}))
import { readRuntimeNativeCliShellSetup } from './native-cli-shell-setup'
it('projects only reduced setup metadata, without paths or contents', async () => {
  state.status.mockResolvedValue({
    supported: true,
    state: 'installed',
    missing: [],
    binDirectory: '/private/home/bin',
    profileFiles: ['/private/home/.profile'],
    contents: 'private'
  })
  expect(await readRuntimeNativeCliShellSetup({})).toEqual({
    supported: true,
    state: 'installed',
    missing: []
  })
})
it('reports unavailable without creating a service', async () => {
  state.available = false
  expect(await readRuntimeNativeCliShellSetup({})).toEqual({
    supported: false,
    state: 'unsupported',
    missing: []
  })
})
