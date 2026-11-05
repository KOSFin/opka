import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it as vitestIt } from 'vitest'
import {
  resolveUnwrappedNativeCliCommand,
  nativeCliExecutableGeneration
} from './native-cli-unwrapped-command'
const it = vitestIt.skipIf(process.platform === 'win32')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'opka-native-resolver-'))
  roots.push(root)
  const bin = join(root, 'managed')
  mkdirSync(bin)
  const command = join(bin, 'claude')
  const native = join(root, 'native-claude')
  const contents = '#!/bin/sh\n# Opka native account launcher v1\nexit 7\n'
  writeFileSync(command, contents, { mode: 0o700 })
  writeFileSync(native, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const entry = {
    nativeExecutable: native,
    shimSha256: createHash('sha256').update(contents).digest('hex')
  }
  const manifest = join(bin, '.opka-native-cli.json')
  writeFileSync(
    manifest,
    JSON.stringify({ version: 1, providers: { claude: entry, codex: entry } }),
    { mode: 0o600 }
  )
  return { root, command, native, manifest }
}
it('unwraps the verified managed PATH shim without executing it or entering the broker', () => {
  const f = fixture()
  expect(resolveUnwrappedNativeCliCommand('claude', f.command)).toBe(f.native)
  expect(resolveUnwrappedNativeCliCommand('claude', f.native)).toBe(f.native)
  expect(resolveUnwrappedNativeCliCommand('claude', 'claude')).toBe('claude')
})
it('refuses missing, modified and writable ownership evidence', () => {
  const f = fixture()
  chmodSync(f.manifest, 0o666)
  expect(() => resolveUnwrappedNativeCliCommand('claude', f.command)).toThrow('ownership')
  chmodSync(f.manifest, 0o600)
  writeFileSync(f.command, '#!/bin/sh\n# Opka native account launcher v1\nexit 8\n')
  expect(() => resolveUnwrappedNativeCliCommand('claude', f.command)).toThrow('ownership')
  rmSync(f.manifest)
  expect(() => resolveUnwrappedNativeCliCommand('claude', f.command)).toThrow()
})
it('refuses a symlinked manifest and recursively managed native target', () => {
  const f = fixture()
  const copy = join(f.root, 'copied-manifest')
  writeFileSync(copy, '{}', { mode: 0o600 })
  rmSync(f.manifest)
  symlinkSync(copy, f.manifest)
  expect(() => resolveUnwrappedNativeCliCommand('claude', f.command)).toThrow('ownership')
  rmSync(f.manifest)
  const entry = {
    nativeExecutable: f.command,
    shimSha256: createHash('sha256')
      .update('#!/bin/sh\n# Opka native account launcher v1\nexit 7\n')
      .digest('hex')
  }
  writeFileSync(
    f.manifest,
    JSON.stringify({ version: 1, providers: { claude: entry, codex: entry } }),
    { mode: 0o600 }
  )
  expect(() => resolveUnwrappedNativeCliCommand('claude', f.command)).toThrow('recursively')
})

it('keys actual version qualification by native file generation rather than PATH spelling', () => {
  const f = fixture(),
    first = nativeCliExecutableGeneration(f.native)
  expect(nativeCliExecutableGeneration(f.native)).toBe(first)
  const alias = join(f.root, 'native-alias')
  symlinkSync(f.native, alias)
  expect(nativeCliExecutableGeneration(alias)).toBe(first)
  writeFileSync(f.native, '#!/bin/sh\nexit 100\n')
  expect(nativeCliExecutableGeneration(f.native)).not.toBe(first)
})
