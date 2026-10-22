import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeMobileWebBundleFixtureTree } from './mobile-web-bundle-fixture-tree.mjs'

const require = createRequire(import.meta.url)
const config = require('../electron-builder.config.cjs')
const { PACKAGED_RUNTIME_PACKAGE_ROOTS } = require('../packaged-runtime-node-modules.cjs')

describe('packaged CLI dependency copying', () => {
  it('keeps the user-facing Mac application out of accessory-only test mode', () => {
    expect(config.mac.extendInfo.LSUIElement).not.toBe(true)
    expect(config.mac.icon).toBeTruthy()
  })
  it('excludes fork journals and temporary build inputs from the app', () => {
    expect(config.files).toEqual(expect.arrayContaining(['!.tmp{,/**/*}', '!fork-docs{,/**/*}']))
  })

  it('retains automatic production dependency collection with a targeted native rebuild', () => {
    expect(config.beforeBuild).toBeUndefined()
    expect(config.npmRebuild).toBe(false)
    const manifest = require('../../package.json')
    expect(manifest.dependencies['@noble/hashes']).toBe('1.8.0')
    expect(manifest.devDependencies['@noble/hashes']).toBeUndefined()
    expect(PACKAGED_RUNTIME_PACKAGE_ROOTS).toContain('@noble/hashes')
  })

  it('rebuilds the requested native slice before packing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cli-package-copy-'))
    try {
      const bundle = join(root, 'mobile-web')
      await writeMobileWebBundleFixtureTree({ outDir: bundle })
      const calls = []
      config.beforePack(
        { electronPlatformName: process.platform, arch: process.arch === 'arm64' ? 3 : 1 },
        bundle,
        () => undefined,
        undefined,
        (context) => calls.push(context)
      )
      expect(calls).toEqual([{ platform: { nodeName: process.platform }, arch: process.arch }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
