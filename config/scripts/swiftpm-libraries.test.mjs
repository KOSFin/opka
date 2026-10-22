import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stalePrivateInterfaces, withSwiftPmLibraries } from './swiftpm-libraries.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(privateVersion = '5.10', publicVersion = '6.3.1') {
  const source = mkdtempSync(path.join(tmpdir(), 'orca-swift-test-'))
  roots.push(source)
  const module = path.join(source, 'ManifestAPI', 'PackageDescription.swiftmodule')
  mkdirSync(module, { recursive: true })
  const contents = (version) =>
    `// swift-compiler-version: Apple Swift (swiftlang-${version} clang-1)\n`
  const publicFile = path.join(module, 'arm64.swiftinterface')
  const privateFile = path.join(module, 'arm64.private.swiftinterface')
  writeFileSync(publicFile, contents(publicVersion))
  writeFileSync(privateFile, contents(privateVersion))
  writeFileSync(path.join(source, 'ManifestAPI', 'libPackageDescription.dylib'), 'library fixture')
  return { source, privateFile }
}

describe('isolated SwiftPM libraries', () => {
  it('copies libraries without stale private interfaces and preserves system inputs', () => {
    const { source, privateFile } = fixture()
    let scratch
    const before = readFileSync(privateFile, 'utf8')
    expect(stalePrivateInterfaces(source).size).toBe(1)
    withSwiftPmLibraries(
      (env) => {
        scratch = env.SWIFTPM_CUSTOM_LIBS_DIR
        expect(scratch).not.toBe(source)
        expect(existsSync(path.join(scratch, path.relative(source, privateFile)))).toBe(false)
        expect(
          existsSync(
            path.join(
              scratch,
              'ManifestAPI',
              'PackageDescription.swiftmodule',
              'arm64.swiftinterface'
            )
          )
        ).toBe(true)
        expect(
          readFileSync(path.join(scratch, 'ManifestAPI', 'libPackageDescription.dylib'), 'utf8')
        ).toBe('library fixture')
      },
      { source, env: {} }
    )
    expect(existsSync(scratch)).toBe(false)
    expect(readFileSync(privateFile, 'utf8')).toBe(before)
  })

  it('does not replace a coherent toolchain or an explicit user override', () => {
    const { source } = fixture('6.3.1')
    const env = { PATH: 'fixture' }
    withSwiftPmLibraries((received) => expect(received).toBe(env), { source, env })
    const override = { SWIFTPM_CUSTOM_LIBS_DIR: '/explicit/toolchain' }
    withSwiftPmLibraries((received) => expect(received).toBe(override), { env: override })
  })

  it('removes the temporary copy when compilation fails', () => {
    const { source } = fixture()
    let scratch
    expect(() =>
      withSwiftPmLibraries(
        (env) => {
          scratch = env.SWIFTPM_CUSTOM_LIBS_DIR
          throw new Error('compilation failed')
        },
        { source, env: {} }
      )
    ).toThrow('compilation failed')
    expect(existsSync(scratch)).toBe(false)
  })
})
