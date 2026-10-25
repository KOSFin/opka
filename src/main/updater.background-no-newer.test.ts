import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const mocks = await vi.hoisted(async () =>
  (await import('./updater-test-harness')).createUpdaterMocks()
)
vi.mock('electron', () => mocks.moduleFactories.electron())
vi.mock('electron-updater', () => mocks.moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => mocks.moduleFactories.electronUpdaterLoader())
vi.mock('@electron-toolkit/utils', () => mocks.moduleFactories.electronToolkitUtils())
vi.mock('./ipc/pty/kill-all', () => mocks.moduleFactories.ptyKillAll())
vi.mock('./linux-update-package-type', () => mocks.moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () =>
  mocks.moduleFactories.updaterLifecycleDiagnostics()
)
vi.mock('./updater-changelog', () => mocks.moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => mocks.moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => mocks.moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', () => mocks.moduleFactories.updaterPrereleaseFeed())
vi.mock('./local-builds/local-build-switch', () => mocks.moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () =>
  mocks.moduleFactories.localBuildFeedServer()
)
warmUpdaterModule()
beforeEach(() => {
  mocks.resetUpdaterMocks()
  mocks.appMock.getVersion.mockReturnValue('1.4.236-rc.2')
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('background beta check with no newer release', () => {
  it.each([false, true])('settles without the stable feed (promoted: %s)', async (promoted) => {
    let finish: (result: { state: 'no-newer'; tags: string[] }) => void = () => {}
    mocks.fetchNewerReleaseTagsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    mocks.fetchNewerReleaseTagsMock.mockResolvedValue({ state: 'no-newer', tags: [] })
    const persisted = vi.fn()
    const updater = await loadUpdaterModule()
    updater.setupAutoUpdater(null, {
      getLastUpdateCheckAt: () => null,
      setLastUpdateCheckAt: persisted
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.fetchNewerReleaseTagsMock).toHaveBeenCalledOnce()
    if (promoted) {
      updater.checkForUpdatesFromMenu()
    }
    finish({ state: 'no-newer', tags: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(persisted).toHaveBeenCalledOnce()
    expect(updater.getUpdateStatus().state).toBe(promoted ? 'not-available' : 'idle')
    if (promoted) {
      expect(updater.getUpdateStatus()).toMatchObject({ userInitiated: true })
    }
    updater.checkForUpdatesFromMenu()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(2)
    expect(updater.getUpdateStatus()).toMatchObject({ state: 'not-available', userInitiated: true })
    expect(mocks.autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })
})
