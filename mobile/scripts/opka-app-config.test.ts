import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
const require = createRequire(import.meta.url)
const configPath = require.resolve('../app.config.js')
afterEach(() => {
  vi.unstubAllEnvs()
  delete require.cache[configPath]
})
function read() {
  delete require.cache[configPath]
  return require(configPath)({
    config: {
      name: 'Orca',
      slug: 'orca-mobile',
      scheme: 'orca',
      android: { package: 'com.stably.orca.mobile', googleServicesFile: './google-services.json' }
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
