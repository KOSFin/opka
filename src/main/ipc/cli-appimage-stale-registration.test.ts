import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliInstallState, CliInstallStatus } from '../../shared/cli-install-types'
import { PRODUCT_IDENTITY } from '../../shared/product-identity'

const mocks = vi.hoisted(() => ({
  profileConstructor: vi.fn(),
  getStatus: vi.fn(),
  legacyGetStatus: vi.fn(),
  legacyInstall: vi.fn(),
  legacyRemove: vi.fn(),
  handle: vi.fn(),
  hydrateShellPath: vi.fn(),
  install: vi.fn(),
  isAppImageRegistrationOwnedBySibling: vi.fn(),
  mergePathSegments: vi.fn(),
  remove: vi.fn(),
  resolveAppImageCacheKey: vi.fn(),
  resolveAppImageRuntimeIdentity: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))

vi.mock('../cli/cli-installer', () => ({
  CliInstaller: class {
    getStatus = mocks.legacyGetStatus
    install = mocks.legacyInstall
    isAppImageRegistrationOwnedBySibling = mocks.isAppImageRegistrationOwnedBySibling
    remove = mocks.legacyRemove
  }
}))

vi.mock('../appimage-runtime-identity', () => ({
  resolveAppImageRuntimeIdentity: mocks.resolveAppImageRuntimeIdentity
}))

vi.mock('../cli/appimage-extracted-root', () => ({
  resolveAppImageCacheKey: mocks.resolveAppImageCacheKey
}))

vi.mock('../cli/wsl-cli-installer', () => ({
  WslCliInstaller: class {
    getStatus = mocks.getStatus
    install = mocks.install
    remove = mocks.remove
  }
}))

vi.mock('../cli/wsl-cli-registration-registry', () => ({
  recordWslCliRegistrationInstalled: vi.fn(),
  recordWslCliRegistrationRemoved: vi.fn()
}))

vi.mock('../cli/wsl-cli-registration-operation', () => ({
  runSerializedWslCliRegistrationOperation: vi.fn()
}))

vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: () => '/private/opka-test-profile'
}))

vi.mock('../cli/profile-cli-registration', () => ({
  ProfileCliRegistration: class {
    constructor(...args: unknown[]) {
      mocks.profileConstructor(...args)
    }
    getStatus = mocks.getStatus
    install = mocks.install
    remove = mocks.remove
  }
}))

vi.mock('../startup/hydrate-shell-path', () => ({
  hydrateShellPath: mocks.hydrateShellPath,
  mergePathSegments: mocks.mergePathSegments
}))

vi.mock('../wsl', () => ({ getDefaultWslDistro: vi.fn() }))

import { registerCliHandlers } from './cli'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function status(
  state: CliInstallState,
  launcherPath = '/cache/current/resources/bin/orca'
): CliInstallStatus {
  return {
    platform: 'linux',
    commandName: PRODUCT_IDENTITY.command,
    commandPath: '/private/opka-test-profile/cli/bin/opka',
    pathDirectory: '/private/opka-test-profile/cli/bin',
    pathConfigured: true,
    launcherPath,
    installMethod: 'wrapper',
    supported: true,
    state,
    currentTarget: state === 'not_installed' ? null : '/cache/old/resources/bin/orca-ide',
    unsupportedReason: null,
    detail: null,
    registrationScope: 'profile'
  }
}

function installStatusHandler(): () => Promise<CliInstallStatus> {
  registerCliHandlers()
  return cliHandler('cli:getInstallStatus')
}

function cliHandler(channelName: string): () => Promise<CliInstallStatus> {
  const call = mocks.handle.mock.calls.find(([channel]) => channel === channelName)
  expect(call).toBeTruthy()
  return call![1]
}

beforeEach(() => {
  mocks.profileConstructor.mockClear()
  mocks.legacyGetStatus.mockClear()
  mocks.legacyInstall.mockClear()
  mocks.legacyRemove.mockClear()
  mocks.getStatus.mockReset()
  mocks.handle.mockReset()
  mocks.hydrateShellPath.mockReset().mockResolvedValue({ ok: false })
  mocks.install.mockReset()
  mocks.isAppImageRegistrationOwnedBySibling.mockReset().mockReturnValue(false)
  mocks.mergePathSegments.mockReset()
  mocks.remove.mockReset()
  mocks.resolveAppImageCacheKey.mockReset().mockReturnValue('generation-1')
  mocks.resolveAppImageRuntimeIdentity.mockReset().mockImplementation(() =>
    process.platform === 'linux'
      ? {
          appImagePath: '/opt/Orca.AppImage'
        }
      : null
  )
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  vi.stubEnv('APPIMAGE', '/opt/Opka.AppImage')
  vi.stubEnv('ORCA_FORK_PROFILE_CLI', '0')
})

afterEach(() => {
  vi.unstubAllEnvs()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  vi.restoreAllMocks()
})

describe('AppImage CLI profile registration', () => {
  it.each(['installed', 'stale', 'conflict', 'not_installed', 'unsupported'] as const)(
    'reports %s profile state without repairing global registrations',
    async (state) => {
      const current = status(state)
      mocks.getStatus.mockResolvedValue(current)
      const handler = installStatusHandler()
      await expect(handler()).resolves.toBe(current)
      await expect(handler()).resolves.toBe(current)
      expect(mocks.install).not.toHaveBeenCalled()
      expect(mocks.legacyGetStatus).not.toHaveBeenCalled()
      expect(mocks.legacyInstall).not.toHaveBeenCalled()
      expect(mocks.hydrateShellPath).not.toHaveBeenCalled()
    }
  )

  it('binds the public command to this profile without isolating native user history', () => {
    registerCliHandlers()
    expect(mocks.profileConstructor).toHaveBeenCalledWith(
      '/private/opka-test-profile',
      process.resourcesPath,
      'linux',
      PRODUCT_IDENTITY.command,
      false
    )
  })

  it('keeps the explicitly isolated profile launcher mode separate', () => {
    vi.stubEnv('ORCA_FORK_PROFILE_CLI', '1')
    registerCliHandlers()
    expect(mocks.profileConstructor).toHaveBeenCalledWith(
      '/private/opka-test-profile',
      process.resourcesPath
    )
  })

  it('shares only read operations across concurrent status polls', async () => {
    const stale = status('stale')
    mocks.getStatus.mockResolvedValue(stale)
    const handler = installStatusHandler()
    await expect(Promise.all([handler(), handler()])).resolves.toEqual([stale, stale])
    expect(mocks.getStatus).toHaveBeenCalledTimes(2)
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('reads a later AppImage generation without rewriting the profile on a poll', async () => {
    const old = status('stale', '/cache/old/resources/bin/orca')
    const current = status('installed')
    mocks.getStatus.mockResolvedValueOnce(old).mockResolvedValueOnce(current)
    const handler = installStatusHandler()
    await expect(handler()).resolves.toBe(old)
    await expect(handler()).resolves.toBe(current)
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('keeps the explicit profile install retryable after a failed attempt', async () => {
    const installed = status('installed')
    mocks.install
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(installed)
    registerCliHandlers()
    const install = cliHandler('cli:install')
    await expect(install()).rejects.toThrow('temporary failure')
    await expect(install()).resolves.toBe(installed)
    expect(mocks.install).toHaveBeenCalledTimes(2)
    expect(mocks.legacyInstall).not.toHaveBeenCalled()
  })

  it('serializes concurrent explicit profile installs', async () => {
    const installed = status('installed')
    let finish: (value: CliInstallStatus) => void = () => {}
    mocks.install
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve
        })
      )
      .mockResolvedValueOnce(installed)
    registerCliHandlers()
    const install = cliHandler('cli:install')
    const first = install()
    const second = install()
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledOnce())
    finish(installed)
    await expect(Promise.all([first, second])).resolves.toEqual([installed, installed])
    expect(mocks.install).toHaveBeenCalledTimes(2)
  })

  it('does not undo a queued profile removal during status reads', async () => {
    const absent = status('not_installed')
    const stale = status('stale')
    let finish: (value: CliInstallStatus) => void = () => {}
    mocks.remove.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    mocks.getStatus.mockResolvedValueOnce(stale).mockResolvedValueOnce(absent)
    registerCliHandlers()
    const removal = cliHandler('cli:remove')()
    await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce())
    await expect(cliHandler('cli:getInstallStatus')()).resolves.toBe(stale)
    expect(mocks.install).not.toHaveBeenCalled()
    finish(absent)
    await expect(removal).resolves.toBe(absent)
    await expect(cliHandler('cli:getInstallStatus')()).resolves.toBe(absent)
    expect(mocks.legacyRemove).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'never repairs a global AppImage registration when sibling ownership is %s',
    async (sibling) => {
      const stale = status('stale')
      mocks.getStatus.mockResolvedValue(stale)
      mocks.isAppImageRegistrationOwnedBySibling.mockReturnValue(sibling)
      await expect(installStatusHandler()()).resolves.toBe(stale)
      expect(mocks.legacyInstall).not.toHaveBeenCalled()
      expect(mocks.isAppImageRegistrationOwnedBySibling).not.toHaveBeenCalled()
      expect(mocks.install).not.toHaveBeenCalled()
    }
  )

  it('keeps an explicit profile removal retryable after failure', async () => {
    const absent = status('not_installed')
    mocks.remove.mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce(absent)
    registerCliHandlers()
    const remove = cliHandler('cli:remove')
    await expect(remove()).rejects.toThrow('temporary failure')
    await expect(remove()).resolves.toBe(absent)
    expect(mocks.remove).toHaveBeenCalledTimes(2)
    expect(mocks.legacyRemove).not.toHaveBeenCalled()
  })
})
