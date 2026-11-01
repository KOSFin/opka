import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
const require = createRequire(import.meta.url)
const configPath = require.resolve('../app.config.js')
afterEach(() => {
  vi.unstubAllEnvs()
  delete require.cache[configPath]
})
function read(android: Record<string, unknown> = {}) {
  delete require.cache[configPath]
  return require(configPath)({
    config: {
      name: 'Orca',
      slug: 'orca-mobile',
      scheme: 'orca',
      android: {
        package: 'com.stably.orca.mobile',
        googleServicesFile: './google-services.json',
        ...android
      }
    }
  })
}
describe('Opka Android identity', () => {
  it('uses a separate install identity without upstream Firebase configuration', () => {
    vi.stubEnv('OPKA_MOBILE_BUILD', '1')
    vi.stubEnv('OPKA_GOOGLE_SERVICES_FILE', '')
    expect(read()).toMatchObject({
      name: 'Opka',
      scheme: 'opka',
      extra: { opkaAndroidPushConfigured: false },
      android: { package: 'com.kosfin.opka.mobile', googleServicesFile: undefined }
    })
  })
  it('keeps the upstream build unchanged when the variant is not requested', () => {
    vi.stubEnv('OPKA_MOBILE_BUILD', '')
    expect(read()).toMatchObject({
      name: 'Orca',
      scheme: 'orca',
      android: { package: 'com.stably.orca.mobile' }
    })
  })
})

it('accepts only an explicit own Firebase configuration input', () => {
  vi.stubEnv('OPKA_MOBILE_BUILD', '1')
  vi.stubEnv('OPKA_GOOGLE_SERVICES_FILE', '/private/opka-google-services.json')
  expect(read()).toMatchObject({
    android: {
      package: 'com.kosfin.opka.mobile',
      googleServicesFile: '/private/opka-google-services.json'
    },
    extra: { opkaAndroidPushConfigured: true }
  })
})

it('blocks the inherited overlay permission only in Opka while preserving native capability settings', () => {
  vi.stubEnv('OPKA_MOBILE_BUILD', '1')
  const android = {
    permissions: ['android.permission.RECORD_AUDIO'],
    blockedPermissions: ['android.permission.READ_CONTACTS'],
    usesCleartextTraffic: true,
    allowBackup: false
  }
  const generated = read(android).android
  expect(generated.blockedPermissions).toEqual([
    'android.permission.READ_CONTACTS',
    'android.permission.SYSTEM_ALERT_WINDOW'
  ])
  expect(generated.permissions).toEqual([
    'android.permission.RECORD_AUDIO',
    'android.permission.REQUEST_INSTALL_PACKAGES'
  ])
  expect(generated.usesCleartextTraffic).toBe(true)
  expect(generated.allowBackup).toBe(false)
  expect(android.blockedPermissions).toEqual(['android.permission.READ_CONTACTS'])
})

it('does not duplicate an existing overlay block or add blocks to an upstream Orca build', () => {
  const android = {
    permissions: ['android.permission.RECORD_AUDIO'],
    blockedPermissions: ['android.permission.SYSTEM_ALERT_WINDOW']
  }
  vi.stubEnv('OPKA_MOBILE_BUILD', '1')
  expect(read(android).android.blockedPermissions).toEqual(android.blockedPermissions)
  vi.stubEnv('OPKA_MOBILE_BUILD', '')
  expect(read(android).android).toEqual({
    package: 'com.stably.orca.mobile',
    googleServicesFile: './google-services.json',
    ...android
  })
  expect(read().android.blockedPermissions).toBeUndefined()
})
