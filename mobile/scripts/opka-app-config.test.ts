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
    expect(read()).toMatchObject({
      name: 'Opka',
      scheme: 'opka',
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
