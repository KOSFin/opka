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
