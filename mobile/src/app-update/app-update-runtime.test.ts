import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ package: 'com.kosfin.opka.mobile', create: vi.fn(() => ({})) }))
vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      version: '0.0.58',
      android: {
        get package() {
          return mocks.package
        }
      }
    }
  }
}))
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: vi.fn() }))
vi.mock('./opka-release-update-source', () => ({ opkaReleaseUpdateSource: { channel: 'opka' } }))
vi.mock('expo-linking', () => ({ openURL: vi.fn() }))
vi.mock('react-native', () => ({
  AppState: {},
  Platform: { OS: 'android' },
  Alert: { alert: vi.fn() }
}))
vi.mock('../storage/app-update-preferences', () => ({
  loadAppUpdatePreferences: vi.fn(),
  saveAppUpdateCheck: vi.fn(),
  saveDismissedAppUpdateVersion: vi.fn()
}))
vi.mock('./app-update-checker', () => ({ createAppUpdateChecker: mocks.create }))
vi.mock('./app-store-update-source', () => ({ appStoreUpdateSource: {} }))
vi.mock('./github-release-update-source', () => ({
  githubReleaseUpdateSource: { channel: 'upstream' }
}))
afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})
describe('native update channel identity', () => {
  it('selects the own channel for the compiled Opka package', async () => {
    mocks.package = 'com.kosfin.opka.mobile'
    await import('./app-update-runtime')
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ source: { channel: 'opka' } })
    )
  })
  it('preserves the upstream package channel', async () => {
    mocks.package = 'dev.onorca.mobile'
    await import('./app-update-runtime')
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ source: { channel: 'upstream' } })
    )
  })
})

describe('Opka native update handoff', () => {
  it('passes the own manifest to the native installer', async () => {
    mocks.package = 'com.kosfin.opka.mobile'
    const { requireOptionalNativeModule } = await import('expo-modules-core')
    const install = vi.fn().mockResolvedValue(undefined)
    vi.mocked(requireOptionalNativeModule).mockReturnValue({ install })
    const { openAppUpdate } = await import('./app-update-runtime')
    const { openURL } = await import('expo-linking')
    openAppUpdate(
      'https://github.com/KOSFin/opka/releases/download/v1.4.236-rc.6/latest-android.json'
    )
    expect(install).toHaveBeenCalledOnce()
    expect(openURL).not.toHaveBeenCalled()
  })
  it('shows a recoverable error when the native bridge is missing', async () => {
    mocks.package = 'com.kosfin.opka.mobile'
    const { requireOptionalNativeModule } = await import('expo-modules-core')
    vi.mocked(requireOptionalNativeModule).mockReturnValue(null)
    const { openAppUpdate } = await import('./app-update-runtime')
    const { Alert } = await import('react-native')
    openAppUpdate(
      'https://github.com/KOSFin/opka/releases/download/v1.4.236-rc.6/latest-android.json'
    )
    await Promise.resolve()
    expect(Alert.alert).toHaveBeenCalledWith(
      'Update could not be opened',
      expect.stringContaining('no Android installer'),
      expect.any(Array)
    )
  })
  it('shows the download verification error without opening a browser fallback', async () => {
    mocks.package = 'com.kosfin.opka.mobile'
    const { requireOptionalNativeModule } = await import('expo-modules-core')
    vi.mocked(requireOptionalNativeModule).mockReturnValue({
      install: vi.fn().mockRejectedValue(new Error('Update checksum mismatch. Please retry.'))
    })
    const { openAppUpdate } = await import('./app-update-runtime')
    const { Alert } = await import('react-native')
    const { openURL } = await import('expo-linking')
    openAppUpdate(
      'https://github.com/KOSFin/opka/releases/download/v1.4.236-rc.6/latest-android.json'
    )
    await Promise.resolve()
    expect(Alert.alert).toHaveBeenCalledWith(
      'Update could not be opened',
      'Update checksum mismatch. Please retry.',
      expect.any(Array)
    )
    expect(openURL).not.toHaveBeenCalled()
  })
})

it('catches synchronous native invocation failures', async () => {
  mocks.package = 'com.kosfin.opka.mobile'
  const { requireOptionalNativeModule } = await import('expo-modules-core')
  vi.mocked(requireOptionalNativeModule).mockReturnValue({
    install: () => {
      throw new Error('bridge failed')
    }
  })
  const { openAppUpdate } = await import('./app-update-runtime')
  const { Alert } = await import('react-native')
  expect(() => openAppUpdate('manifest')).not.toThrow()
  expect(Alert.alert).toHaveBeenCalledWith(
    'Update could not be opened',
    'bridge failed',
    expect.any(Array)
  )
})

it('coalesces repeated taps while native download is pending', async () => {
  mocks.package = 'com.kosfin.opka.mobile'
  const { requireOptionalNativeModule } = await import('expo-modules-core')
  const install = vi.fn(() => new Promise<void>(() => {}))
  vi.mocked(requireOptionalNativeModule).mockReturnValue({ install })
  const { openAppUpdate } = await import('./app-update-runtime')
  const { appUpdateInstallBusy } = await import('./app-update-install-state')
  openAppUpdate('manifest')
  openAppUpdate('manifest')
  expect(install).toHaveBeenCalledOnce()
  expect(appUpdateInstallBusy()).toBe(true)
})

it('publishes native transfer progress and removes its listener after handoff', async () => {
  mocks.package = 'com.kosfin.opka.mobile'
  const { requireOptionalNativeModule } = await import('expo-modules-core')
  let notify:
    | ((event: { phase: string; downloadedBytes?: number; totalBytes?: number }) => void)
    | undefined
  let finish: (() => void) | undefined
  const remove = vi.fn()
  vi.mocked(requireOptionalNativeModule).mockReturnValue({
    install: () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    addListener: (_name: string, listener: NonNullable<typeof notify>) => {
      notify = listener
      return { remove }
    }
  })
  const { openAppUpdate } = await import('./app-update-runtime')
  const { getAppUpdateInstallSnapshot } = await import('./app-update-install-state')
  openAppUpdate('manifest')
  notify?.({ phase: 'downloading', downloadedBytes: 25, totalBytes: 100 })
  expect(getAppUpdateInstallSnapshot().label).toContain('25%')
  finish?.()
  await Promise.resolve()
  expect(getAppUpdateInstallSnapshot()).toMatchObject({ phase: 'installer', busy: false })
  expect(remove).toHaveBeenCalledOnce()
})

it('cancels a native download, keeps it busy until cleanup, and permits retry', async () => {
  mocks.package = 'com.kosfin.opka.mobile'
  const { requireOptionalNativeModule } = await import('expo-modules-core')
  let notify:
    | ((event: { phase: string; downloadedBytes?: number; totalBytes?: number }) => void)
    | undefined
  let rejectInstall: ((error: Error) => void) | undefined
  const cancel = vi.fn().mockResolvedValue(true)
  const install = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectInstall = reject
      })
  )
  vi.mocked(requireOptionalNativeModule).mockReturnValue({
    install,
    installTracked: install,
    cancel,
    addListener: (_name: string, listener: NonNullable<typeof notify>) => {
      notify = listener
      return { remove: vi.fn() }
    }
  })
  const { openAppUpdate, cancelAppUpdate } = await import('./app-update-runtime')
  const { getAppUpdateInstallSnapshot } = await import('./app-update-install-state')
  const { Alert } = await import('react-native')
  openAppUpdate('manifest')
  notify?.({ phase: 'downloading', downloadedBytes: 1, totalBytes: 10 })
  expect(getAppUpdateInstallSnapshot()).toMatchObject({ phase: 'downloading', canCancel: true })
  cancelAppUpdate()
  expect(getAppUpdateInstallSnapshot()).toMatchObject({ phase: 'cancelling', busy: true })
  await Promise.resolve()
  expect(cancel).toHaveBeenCalledOnce()
  expect(cancel).toHaveBeenCalledWith(expect.any(String))
  rejectInstall?.(new Error('Update download cancelled.'))
  await vi.waitFor(() =>
    expect(getAppUpdateInstallSnapshot()).toMatchObject({ phase: 'cancelled', busy: false })
  )
  expect(Alert.alert).not.toHaveBeenCalled()
  openAppUpdate('manifest')
  expect(install).toHaveBeenCalledTimes(2)
})

it('does not offer cancellation to a native module without the cancel method', async () => {
  mocks.package = 'com.kosfin.opka.mobile'
  const { requireOptionalNativeModule } = await import('expo-modules-core')
  let notify: ((event: { phase: string }) => void) | undefined
  vi.mocked(requireOptionalNativeModule).mockReturnValue({
    install: () => new Promise<void>(() => {}),
    addListener: (_name: string, listener: NonNullable<typeof notify>) => {
      notify = listener
      return { remove: vi.fn() }
    }
  })
  const { openAppUpdate, cancelAppUpdate } = await import('./app-update-runtime')
  const { getAppUpdateInstallSnapshot } = await import('./app-update-install-state')
  openAppUpdate('manifest')
  notify?.({ phase: 'downloading' })
  expect(getAppUpdateInstallSnapshot().canCancel).toBe(false)
  expect(getAppUpdateInstallSnapshot().label).toContain('Cancel is unavailable')
  cancelAppUpdate()
  expect(getAppUpdateInstallSnapshot().phase).toBe('downloading')
})

it('shows a cleanup failure after cancellation instead of claiming the file was removed', async () => {
  mocks.package = 'com.kosfin.opka.mobile'
  const { requireOptionalNativeModule } = await import('expo-modules-core')
  let notify: ((event: { phase: string }) => void) | undefined
  let rejectInstall: ((error: Error) => void) | undefined
  vi.mocked(requireOptionalNativeModule).mockReturnValue({
    install: vi.fn(),
    installTracked: () =>
      new Promise<void>((_resolve, reject) => {
        rejectInstall = reject
      }),
    cancel: vi.fn().mockResolvedValue(true),
    addListener: (_name: string, listener: NonNullable<typeof notify>) => {
      notify = listener
      return { remove: vi.fn() }
    }
  })
  const { openAppUpdate, cancelAppUpdate } = await import('./app-update-runtime')
  const { getAppUpdateInstallSnapshot } = await import('./app-update-install-state')
  const { Alert } = await import('react-native')
  openAppUpdate('manifest')
  notify?.({ phase: 'downloading' })
  cancelAppUpdate()
  await Promise.resolve()
  rejectInstall?.(new Error('Could not remove the unfinished update file. Please retry.'))
  await vi.waitFor(() => expect(getAppUpdateInstallSnapshot().phase).toBe('failed'))
  expect(Alert.alert).toHaveBeenCalledWith(
    'Update could not be opened',
    'Could not remove the unfinished update file. Please retry.',
    expect.any(Array)
  )
})

it('keeps the installer handoff when native cancellation loses the race', async () => {
  mocks.package = 'com.kosfin.opka.mobile'
  const { requireOptionalNativeModule } = await import('expo-modules-core')
  let notify: ((event: { phase: string }) => void) | undefined
  let finish: (() => void) | undefined
  vi.mocked(requireOptionalNativeModule).mockReturnValue({
    install: vi.fn(),
    installTracked: () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    cancel: vi.fn().mockResolvedValue(false),
    addListener: (_name: string, listener: NonNullable<typeof notify>) => {
      notify = listener
      return { remove: vi.fn() }
    }
  })
  const { openAppUpdate, cancelAppUpdate } = await import('./app-update-runtime')
  const { getAppUpdateInstallSnapshot } = await import('./app-update-install-state')
  openAppUpdate('manifest')
  notify?.({ phase: 'downloading' })
  cancelAppUpdate()
  finish?.()
  await vi.waitFor(() => expect(getAppUpdateInstallSnapshot().phase).toBe('installer'))
})
