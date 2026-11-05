import { expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  shutdown: vi.fn(async () => {}),
  construct: vi.fn(),
  guard: vi.fn()
}))
vi.mock('../cli/native-cli-user-integration-host', () => ({
  NativeCliUserIntegrationHost: class {
    constructor(options: unknown) {
      state.construct(options)
    }
    shutdown = state.shutdown
  }
}))
vi.mock('./native-account-profile-ownership', () => ({
  captureNativeAccountProfileOwnership: () => state.guard
}))
import {
  configureNativeCliUserIntegration,
  getRuntimeNativeCliUserIntegration,
  shutdownRuntimeNativeCliUserIntegration
} from './configure-native-cli-user-integration'
it('configures one lazy service per runtime and registers teardown without touching the home', async () => {
  const runtime = {},
    cleanups: (() => Promise<void>)[] = []
  expect(getRuntimeNativeCliUserIntegration(runtime)).toBeNull()
  configureNativeCliUserIntegration(runtime, {
    store: { getProfileStorageDirectory: () => '/unused-profile' },
    dataRoot: '/unused-owner',
    registerCleanup: (cleanup) => cleanups.push(cleanup)
  })
  expect(state.construct).toHaveBeenCalledTimes(1)
  expect(state.construct).toHaveBeenCalledWith(
    expect.objectContaining({ profileRoot: '/unused-profile', dataRoot: '/unused-owner' })
  )
  expect(state.guard).not.toHaveBeenCalled()
  expect(getRuntimeNativeCliUserIntegration(runtime)).not.toBeNull()
  expect(() =>
    configureNativeCliUserIntegration(runtime, {
      store: { getProfileStorageDirectory: () => '/unused-profile' },
      dataRoot: '/unused-owner'
    })
  ).toThrow('already configured')
  await cleanups[0]()
  await shutdownRuntimeNativeCliUserIntegration(runtime)
  expect(state.shutdown).toHaveBeenCalledTimes(2)
})
