import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const versionCode: (version: string) => number = require('./opka-version-code.cjs')
describe('Opka Android version code', () => {
  it('increases for beta revisions and patch releases across independent build workflows', () => {
    expect(versionCode('1.4.236-rc.10')).toBeGreaterThan(versionCode('1.4.236-rc.9'))
    expect(versionCode('1.4.237-rc.1')).toBeGreaterThan(versionCode('1.4.236-rc.999'))
    expect(versionCode('1.4.236-rc.1')).toBeGreaterThan(22)
  })
  it.each(['invalid', '1.4.236', '1.4.236-rc.1000', '99.4.236-rc.1'])(
    'rejects unsupported version %s',
    (version) => {
      expect(() => versionCode(version)).toThrow()
    }
  )
})
