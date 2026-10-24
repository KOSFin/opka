import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const mocks = await vi.hoisted(async () =>
  (await import('./updater-test-harness')).createUpdaterMocks()
)
const beta = vi.hoisted(() => ({ download: vi.fn(), open: vi.fn() }))
vi.mock('electron', () => {
  const electron = mocks.moduleFactories.electron()
  return { ...electron, app: { ...electron.app, getPath: () => '/synthetic-temp' } }
})
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
vi.mock('./updater/mac-beta-update-policy', () => ({ usesManualMacInstaller: () => true }))
vi.mock('./updater/mac-beta-installer', () => ({
  MacBetaInstaller: class {
    download = beta.download
    openInstaller = beta.open
  }
}))
warmUpdaterModule()
afterEach(() => vi.useRealTimers())
beforeEach(() => {
  mocks.resetUpdaterMocks()
  mocks.appMock.getVersion.mockReturnValue('0.1.0-rc.1')
  mocks.fetchNewerReleaseTagsMock.mockResolvedValue({ state: 'ready', tags: ['v0.1.0-rc.2'] })
  vi.useFakeTimers()
  beta.download.mockReset().mockResolvedValue(undefined)
  beta.open.mockReset().mockResolvedValue(undefined)
})
async function availableUpdater() {
  const updater = await loadUpdaterModule()
  updater.setupAutoUpdater(null, { getLastUpdateCheckAt: () => Date.now() })
  updater.checkForUpdatesFromMenu()
  await vi.advanceTimersByTimeAsync(0)
  mocks.autoUpdaterMock.emit('checking-for-update')
  mocks.autoUpdaterMock.emit('update-available', { version: '0.1.0-rc.2' })
  await vi.advanceTimersByTimeAsync(0)
  expect(updater.getUpdateStatus()).toMatchObject({ state: 'available', manualInstaller: true })
  return updater
}
describe('manual Mac beta update integration', () => {
  it('downloads and opens on explicit actions without invoking Squirrel or quitting', async () => {
    const updater = await availableUpdater()
    updater.downloadUpdate()
    await vi.advanceTimersByTimeAsync(0)
    expect(beta.download).toHaveBeenCalledOnce()
    expect(updater.getUpdateStatus()).toMatchObject({ state: 'downloaded', manualInstaller: true })
    expect(beta.open).not.toHaveBeenCalled()
    updater.quitAndInstall()
    await vi.advanceTimersByTimeAsync(0)
    expect(beta.open).toHaveBeenCalledOnce()
    expect(mocks.autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
    expect(mocks.autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(mocks.appMock.quit).not.toHaveBeenCalled()
  })
  it('allows a download retry after a checksum failure and rejects duplicate in-flight actions', async () => {
    const updater = await availableUpdater()
    beta.download.mockRejectedValueOnce(new Error('checksum mismatch'))
    updater.downloadUpdate()
    updater.downloadUpdate()
    await vi.advanceTimersByTimeAsync(0)
    expect(beta.download).toHaveBeenCalledOnce()
    expect(updater.getUpdateStatus()).toMatchObject({ state: 'error', manualInstaller: true })
    updater.downloadUpdate()
    await vi.advanceTimersByTimeAsync(0)
    expect(beta.download).toHaveBeenCalledTimes(2)
    expect(updater.getUpdateStatus().state).toBe('downloaded')
  })
})
