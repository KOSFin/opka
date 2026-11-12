import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENGINE_MIT_NOTICE, type EngineAssetPin } from './engine-asset-pin'
import { retireEngineAssetCacheVersions } from './engine-asset-cache-retirement'

let root: string
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const pin = (version: number): EngineAssetPin => ({
  version: `8.0.${version}`,
  target: 'synthetic-x64',
  binaryMember: 'cli-proxy-api',
  url: '',
  archiveSha256: 'a'.repeat(64),
  archiveBytes: 1
})
const directory = (version: number): string =>
  join(root, `${pin(version).version}-${pin(version).target}`)
async function install(version: number): Promise<void> {
  const path = directory(version)
  const binary = `synthetic-engine-${version}`
  await mkdir(path, { mode: 0o700 })
  await writeFile(join(path, 'cli-proxy-api'), binary, { mode: 0o700 })
  await writeFile(join(path, 'LICENSE'), ENGINE_MIT_NOTICE, { mode: 0o600 })
  await writeFile(
    join(path, 'receipt.json'),
    JSON.stringify({
      archiveSha256: 'a'.repeat(64),
      archiveBytes: 1,
      target: 'synthetic-x64',
      version: pin(version).version,
      binarySha256: sha(binary),
      binaryBytes: Buffer.byteLength(binary)
    }),
    { mode: 0o600 }
  )
  await utimes(join(path, 'receipt.json'), version, version)
}
const options = () => ({
  cacheDirectory: root,
  assertExclusiveInstallLease: vi.fn(),
  assertCanReplaceInstalledBinary: vi.fn<(path: string) => void>()
})
const retire = (input: ReturnType<typeof options>, version = 4) =>
  retireEngineAssetCacheVersions(input, pin(version), new AbortController().signal)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'engine-cache-retirement-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(typeof process.getuid !== 'function')('verified engine cache retirement', () => {
  it('bounds repeated upgrades to current plus one previous version without changing retained bytes', async () => {
    for (let version = 1; version <= 4; version++) {
      await install(version)
    }
    const retained = await Promise.all(
      [3, 4].map((version) => readFile(join(directory(version), 'receipt.json'), 'utf8'))
    )
    const input = options()
    await retire(input)
    expect((await readdir(root)).sort()).toEqual(['8.0.3-synthetic-x64', '8.0.4-synthetic-x64'])
    expect(
      await Promise.all(
        [3, 4].map((version) => readFile(join(directory(version), 'receipt.json'), 'utf8'))
      )
    ).toEqual(retained)
    expect(await readFile(join(directory(3), 'cli-proxy-api'), 'utf8')).toBe('synthetic-engine-3')
    expect(await readFile(join(directory(4), 'cli-proxy-api'), 'utf8')).toBe('synthetic-engine-4')
    for (let version = 5; version <= 7; version++) {
      await install(version)
      await retire(input, version)
      expect((await readdir(root)).sort()).toEqual([
        `8.0.${version - 1}-synthetic-x64`,
        `8.0.${version}-synthetic-x64`
      ])
      expect(await readFile(join(directory(version - 1), 'cli-proxy-api'), 'utf8')).toBe(
        `synthetic-engine-${version - 1}`
      )
      expect(await readFile(join(directory(version), 'cli-proxy-api'), 'utf8')).toBe(
        `synthetic-engine-${version}`
      )
    }
    expect(input.assertCanReplaceInstalledBinary).not.toHaveBeenCalledWith(directory(7))
  })

  it.each(['live', 'unverifiable'])(
    'preserves every version when an old engine owner is %s',
    async (verdict) => {
      for (let version = 1; version <= 4; version++) {
        await install(version)
      }
      const input = options()
      input.assertCanReplaceInstalledBinary.mockImplementation(() => {
        throw new Error(`Old owner ${verdict}`)
      })
      await expect(retire(input)).rejects.toThrow(`Old owner ${verdict}`)
      expect(await readdir(root)).toHaveLength(4)
      for (let version = 1; version <= 4; version++) {
        expect(await readFile(join(directory(version), 'cli-proxy-api'), 'utf8')).toBe(
          `synthetic-engine-${version}`
        )
      }
    }
  )

  it('preserves all versions if the exclusive lease is lost before retirement', async () => {
    for (let version = 1; version <= 4; version++) {
      await install(version)
    }
    const input = options()
    input.assertExclusiveInstallLease
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error('Concurrent writer')
      })
    await expect(retire(input)).rejects.toThrow('Concurrent writer')
    expect(await readdir(root)).toHaveLength(4)
    expect(input.assertCanReplaceInstalledBinary).not.toHaveBeenCalled()
  })

  it('never prunes unknown, symlinked, damaged or non-private entries', async () => {
    for (let version = 1; version <= 4; version++) {
      await install(version)
    }
    const unknown = join(root, 'unknown')
    await mkdir(unknown, { mode: 0o700 })
    await writeFile(join(unknown, 'keep'), 'unknown bytes')
    await symlink(unknown, join(root, '8.0.0-synthetic-x64'))
    await install(8)
    await writeFile(join(directory(8), 'cli-proxy-api'), 'damaged bytes')
    await install(9)
    await chmod(directory(9), 0o755)
    const input = options()
    await retire(input)
    expect((await readdir(root)).sort()).toEqual([
      '8.0.0-synthetic-x64',
      '8.0.3-synthetic-x64',
      '8.0.4-synthetic-x64',
      '8.0.8-synthetic-x64',
      '8.0.9-synthetic-x64',
      'unknown'
    ])
    expect(await readFile(join(unknown, 'keep'), 'utf8')).toBe('unknown bytes')
    expect(await readFile(join(directory(8), 'cli-proxy-api'), 'utf8')).toBe('damaged bytes')
    for (const path of [unknown, directory(8), directory(9), join(root, '8.0.0-synthetic-x64')]) {
      expect(input.assertCanReplaceInstalledBinary).not.toHaveBeenCalledWith(path)
    }
  })
})
