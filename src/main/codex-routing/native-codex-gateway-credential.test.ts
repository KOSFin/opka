import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  prepareNativeCodexGatewayAuth,
  readOrCreateNativeCodexGatewayCredential
} from './native-codex-gateway-credential'

const roots: string[] = []
const exclusive = () => {}
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'native-gateway-key-'))
  roots.push(path)
  return path
}
afterEach(() => {
  for (const path of roots.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

it('persists one profile-local key across 1000 reads without files, inode or block growth', () => {
  const root = directory()
  const key = readOrCreateNativeCodexGatewayCredential(root, exclusive)
  const file = join(root, 'native-gateway-key')
  const before = lstatSync(file)
  expect(key).toMatch(/^[a-f0-9]{64}$/)
  for (let index = 0; index < 1000; index++) {
    expect(readOrCreateNativeCodexGatewayCredential(root, exclusive)).toBe(key)
  }
  const after = lstatSync(file)
  expect([after.ino, after.blocks, after.size, after.nlink]).toEqual([
    before.ino,
    before.blocks,
    64,
    1
  ])
  expect(readdirSync(root)).toEqual(['native-gateway-key'])
  if (process.platform !== 'win32') {
    expect(after.mode & 0o777).toBe(0o600)
  }
  expect(readOrCreateNativeCodexGatewayCredential(directory(), exclusive)).not.toBe(key)
})

it('writes only canonical API-key auth once and preserves its bytes and inode on reuse', () => {
  const home = directory()
  const key = 'a'.repeat(64)
  prepareNativeCodexGatewayAuth(home, key, exclusive)
  const file = join(home, 'auth.json')
  const before = lstatSync(file)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
    auth_mode: 'apikey',
    OPENAI_API_KEY: key
  })
  for (let index = 0; index < 1000; index++) {
    prepareNativeCodexGatewayAuth(home, key, exclusive)
  }
  expect(lstatSync(file).ino).toBe(before.ino)
  expect(readdirSync(home)).toEqual(['auth.json'])
})

it.each(['short', 'A'.repeat(64), 'a'.repeat(65), `${'a'.repeat(64)}\n`])(
  'refuses corrupt existing gateway key without replacement',
  (value) => {
    const root = directory()
    const file = join(root, 'native-gateway-key')
    writeFileSync(file, value, { mode: 0o600 })
    expect(() => readOrCreateNativeCodexGatewayCredential(root, exclusive)).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(value)
  }
)

it.each([
  JSON.stringify({ tokens: { refresh_token: 'synthetic-provider-refresh' } }),
  JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'b'.repeat(64) }),
  '{}'
])('refuses existing native/provider login without overwriting or creating a stage', (value) => {
  const home = directory()
  const file = join(home, 'auth.json')
  writeFileSync(file, value, { mode: 0o600 })
  expect(() => prepareNativeCodexGatewayAuth(home, 'a'.repeat(64), exclusive)).toThrow()
  expect(readFileSync(file, 'utf8')).toBe(value)
  expect(readdirSync(home)).toEqual(['auth.json'])
})

it('leaves bounded crash staging untrusted and never silently rotates the key', () => {
  const root = directory()
  let checks = 0
  expect(() =>
    readOrCreateNativeCodexGatewayCredential(root, () => {
      if (++checks === 3) {
        throw new Error('profile lease lost')
      }
    })
  ).toThrow('profile lease lost')
  const stage = join(root, 'native-gateway-key.next')
  expect(lstatSync(stage).size).toBe(64)
  expect(existsSync(join(root, 'native-gateway-key'))).toBe(false)
  expect(() => readOrCreateNativeCodexGatewayCredential(root, exclusive)).toThrow('pending')
  expect(lstatSync(stage).size).toBe(64)
})

it('refuses pending auth publication even beside a valid committed file', () => {
  const home = directory()
  prepareNativeCodexGatewayAuth(home, 'a'.repeat(64), exclusive)
  writeFileSync(join(home, 'auth.json.next'), 'pending', { mode: 0o600 })
  expect(() => prepareNativeCodexGatewayAuth(home, 'a'.repeat(64), exclusive)).toThrow('pending')
  expect(readFileSync(join(home, 'auth.json.next'), 'utf8')).toBe('pending')
})

it.skipIf(process.platform === 'win32')(
  'refuses public, hardlinked and symlinked credentials',
  () => {
    const root = directory()
    const file = join(root, 'native-gateway-key')
    writeFileSync(file, 'a'.repeat(64), { mode: 0o644 })
    expect(() => readOrCreateNativeCodexGatewayCredential(root, exclusive)).toThrow('private')
    chmodSync(file, 0o600)
    const other = join(root, 'other')
    linkSync(file, other)
    expect(() => readOrCreateNativeCodexGatewayCredential(root, exclusive)).toThrow('private')
    rmSync(file)
    symlinkSync(other, file)
    expect(() => readOrCreateNativeCodexGatewayCredential(root, exclusive)).toThrow('private')
    expect(readFileSync(other, 'utf8')).toBe('a'.repeat(64))
  }
)
