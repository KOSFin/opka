import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as PinModule from './engine-asset-pin'
import { ENGINE_MIT_NOTICE } from './engine-asset-pin'
import { ensurePinnedEngineAsset, type EngineAssetCacheOptions } from './engine-asset-cache'
import { extractEngineAsset } from './engine-asset-extraction'
import { writeSkillTarGzip } from '../skills/skill-package-tar'

const state = vi.hoisted(() => ({
  pin: {
    target: 'synthetic-x64',
    version: '8.0.55',
    url: 'https://fixture.invalid/archive.zip',
    archiveSha256: '',
    archiveBytes: 0,
    binaryMember: 'cli-proxy-api'
  }
}))
vi.mock('./engine-asset-pin', async (original) => ({
  ...(await original<typeof PinModule>()),
  getEngineAssetPin: () => ({ ...state.pin })
}))
let root: string
let bytes: Uint8Array
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opka-engine-asset-'))
  bytes = zipSync({
    'cli-proxy-api': Buffer.from('synthetic-not-executed'),
    LICENSE: Buffer.from(ENGINE_MIT_NOTICE),
    'README.md': Buffer.from('ignored documentation')
  })
  state.pin.url = 'https://fixture.invalid/archive.zip'
  state.pin.archiveSha256 = createHash('sha256').update(bytes).digest('hex')
  state.pin.archiveBytes = bytes.length
  fetcher = vi.fn<typeof fetch>(async () => new Response(Buffer.from(bytes)))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
function options(): EngineAssetCacheOptions {
  return {
    cacheDirectory: join(root, 'cache'),
    fetcher,
    assertExclusiveInstallLease: vi.fn(),
    assertCanReplaceInstalledBinary: vi.fn()
  }
}

it('installs only verified binary/license/receipt and reuses it without download or archive retention', async () => {
  const input = options()
  const first = await ensurePinnedEngineAsset(input)
  expect(first.reused).toBe(false)
  expect(first.expectedSha256).toBe(
    createHash('sha256').update('synthetic-not-executed').digest('hex')
  )
  const folder = join(input.cacheDirectory, '8.0.55-synthetic-x64')
  expect((await readdir(folder)).sort()).toEqual(['LICENSE', 'cli-proxy-api', 'receipt.json'])
  expect(await readdir(input.cacheDirectory)).toEqual(['8.0.55-synthetic-x64'])
  expect(await readFile(join(folder, 'LICENSE'), 'utf8')).toBe(ENGINE_MIT_NOTICE)
  expect((await ensurePinnedEngineAsset(input)).reused).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(input.assertCanReplaceInstalledBinary).not.toHaveBeenCalled()
})

it('installs a protected local replay archive only for its exact binary and host architecture', async () => {
  const linux = Buffer.alloc(64)
  linux.write('\x7fELF', 0, 'binary')
  linux[4] = 2
  linux[5] = 1
  linux.writeUInt16LE(62, 18)
  const archive = join(root, 'packaged.zip')
  const content = zipSync({
    'cli-proxy-api': linux,
    LICENSE: Buffer.from(ENGINE_MIT_NOTICE)
  })
  await writeFile(archive, content)
  const input = options()
  input.platform = 'linux'
  input.arch = 'x64'
  input.packaged = {
    archivePath: archive,
    binarySha256: createHash('sha256').update(linux).digest('hex'),
    pin: {
      target: 'linux-x64',
      version: '8.0.55-orca-replay-synthetic',
      url: '',
      archiveSha256: createHash('sha256').update(content).digest('hex'),
      archiveBytes: content.length,
      binaryMember: 'cli-proxy-api'
    }
  }
  const installed = await ensurePinnedEngineAsset(input)
  expect(installed.version).toBe('8.0.55-orca-replay-synthetic')
  expect(await readFile(installed.binaryPath)).toEqual(linux)
  expect((await ensurePinnedEngineAsset(input)).reused).toBe(true)
  expect(fetcher).not.toHaveBeenCalled()

  input.packaged.pin.target = 'linux-arm64'
  await expect(ensurePinnedEngineAsset(input)).rejects.toThrow('target')
  input.packaged.pin.target = 'linux-x64'
  input.packaged.binarySha256 = '0'.repeat(64)
  await expect(ensurePinnedEngineAsset(input)).rejects.toThrow('binary')
  input.packaged.binarySha256 = installed.expectedSha256
  await writeFile(archive, 'changed packaged archive')
  await expect(ensurePinnedEngineAsset(input)).rejects.toThrow('byte count')
  expect(fetcher).not.toHaveBeenCalled()
})

it('recovers bounded owned crash staging under an exclusive lease', async () => {
  const input = options()
  await mkdir(join(input.cacheDirectory, '.install'), { recursive: true })
  await writeFile(join(input.cacheDirectory, '.install', 'archive.part.zip'), 'crashed download')
  await ensurePinnedEngineAsset(input)
  expect(await readdir(input.cacheDirectory)).toEqual(['8.0.55-synthetic-x64'])
})

it('does not delete crash residue when the previous writer is unverifiable', async () => {
  const input = options()
  await mkdir(join(input.cacheDirectory, '.install'), { recursive: true })
  const partial = join(input.cacheDirectory, '.install', 'archive.part.zip')
  await writeFile(partial, 'preserve')
  input.assertExclusiveInstallLease = () => {
    throw new Error('unverifiable writer')
  }
  await expect(ensurePinnedEngineAsset(input)).rejects.toThrow('unverifiable')
  expect(await readFile(partial, 'utf8')).toBe('preserve')
  expect(fetcher).not.toHaveBeenCalled()
})

it('preserves damaged in-use binaries and repairs only after host proves retirement', async () => {
  const input = options()
  const installed = await ensurePinnedEngineAsset(input)
  await writeFile(installed.binaryPath, 'damaged')
  input.assertCanReplaceInstalledBinary = () => {
    throw new Error('live binary')
  }
  await expect(ensurePinnedEngineAsset(input)).rejects.toThrow('live binary')
  expect(await readFile(installed.binaryPath, 'utf8')).toBe('damaged')
  expect(fetcher).toHaveBeenCalledTimes(1)
  input.assertCanReplaceInstalledBinary = vi.fn()
  expect((await ensurePinnedEngineAsset(input)).reused).toBe(false)
  expect(await readFile(installed.binaryPath, 'utf8')).toBe('synthetic-not-executed')
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('rejects checksum and exact-byte mismatches without publishing or retaining archives', async () => {
  const input = options()
  state.pin.archiveSha256 = '0'.repeat(64)
  await expect(ensurePinnedEngineAsset(input)).rejects.toThrow('checksum mismatch')
  expect(await readdir(input.cacheDirectory)).toEqual([])
  state.pin.archiveSha256 = createHash('sha256').update(bytes).digest('hex')
  state.pin.archiveBytes += 1
  await expect(ensurePinnedEngineAsset(input)).rejects.toThrow('byte count')
  expect(await readdir(input.cacheDirectory)).toEqual([])
})

it('cleans a cancelled download without publishing a binary', async () => {
  const input = options(),
    abort = new AbortController()
  input.signal = abort.signal
  input.fetcher = async () => {
    abort.abort(new Error('synthetic cancel'))
    return new Response(Buffer.from(bytes))
  }
  await expect(ensurePinnedEngineAsset(input)).rejects.toThrow('synthetic cancel')
  expect(await readdir(input.cacheDirectory)).toEqual([])
})

it('installs an upgrade beside an old engine without replacing or pruning its files', async () => {
  const input = options()
  const old = join(input.cacheDirectory, '8.0.54-synthetic-x64')
  await mkdir(old, { recursive: true })
  await writeFile(join(old, 'cli-proxy-api'), 'retained-old-binary')
  await writeFile(join(old, 'receipt.json'), 'retained-old-receipt')
  input.assertCanReplaceInstalledBinary = () => {
    throw new Error('Old owner still retains its binary')
  }
  const installed = await ensurePinnedEngineAsset(input)
  expect(installed.reused).toBe(false)
  expect((await ensurePinnedEngineAsset(input)).reused).toBe(true)
  expect((await readdir(input.cacheDirectory)).sort()).toEqual([
    '8.0.54-synthetic-x64',
    '8.0.55-synthetic-x64'
  ])
  expect(await readFile(join(old, 'cli-proxy-api'), 'utf8')).toBe('retained-old-binary')
  expect(await readFile(join(old, 'receipt.json'), 'utf8')).toBe('retained-old-receipt')
  expect(fetcher).toHaveBeenCalledOnce()
})

it('does not install an upgrade without the owning host exclusive lease', async () => {
  const input = options()
  const old = join(input.cacheDirectory, '8.0.54-synthetic-x64')
  await mkdir(old, { recursive: true })
  await writeFile(join(old, 'cli-proxy-api'), 'retained-old-binary')
  input.assertExclusiveInstallLease = () => {
    throw new Error('Previous writer is unverifiable')
  }
  await expect(ensurePinnedEngineAsset(input)).rejects.toThrow('Previous writer is unverifiable')
  expect(await readdir(input.cacheDirectory)).toEqual(['8.0.54-synthetic-x64'])
  expect(await readFile(join(old, 'cli-proxy-api'), 'utf8')).toBe('retained-old-binary')
  expect(fetcher).not.toHaveBeenCalled()
})

it('rejects traversal, links and duplicate names in archive metadata', async () => {
  const output = join(root, 'extract')
  await mkdir(output)
  for (const unsafe of ['../escape', 'folder/cli-proxy-api', 'C:\\escape']) {
    const archive = join(root, 'unsafe.zip')
    await writeFile(archive, zipSync({ [unsafe]: Buffer.from('no') }))
    await expect(
      extractEngineAsset(archive, output, 'cli-proxy-api', new AbortController().signal)
    ).rejects.toThrow('unsafe')
  }
  const linked = join(root, 'link.zip')
  await writeFile(
    linked,
    zipSync({
      'cli-proxy-api': [Buffer.from('target'), { os: 3, attrs: 0o120777 << 16 }],
      LICENSE: Buffer.from(ENGINE_MIT_NOTICE)
    })
  )
  await expect(
    extractEngineAsset(linked, output, 'cli-proxy-api', new AbortController().signal)
  ).rejects.toThrow('link or special')
  const duplicate = Buffer.from(
    zipSync({
      'cli-proxy-api': Buffer.from('binary'),
      LICENSE: Buffer.from(ENGINE_MIT_NOTICE),
      COPYING: Buffer.from('duplicate')
    })
  )
  let offset = duplicate.indexOf(Buffer.from('COPYING'))
  while (offset !== -1) {
    Buffer.from('LICENSE').copy(duplicate, offset)
    offset = duplicate.indexOf(Buffer.from('COPYING'), offset + 7)
  }
  await writeFile(linked, duplicate)
  await expect(
    extractEngineAsset(linked, output, 'cli-proxy-api', new AbortController().signal)
  ).rejects.toThrow()
  expect(await readdir(output)).toEqual([])
})

it('reuses the bounded reader for official GNU tar headers without extracting documentation', async () => {
  const archive = join(root, 'fixture.tar.gz')
  const files = {
    'cli-proxy-api': Buffer.from('synthetic-not-executed'),
    LICENSE: Buffer.from(ENGINE_MIT_NOTICE),
    'README.md': Buffer.from('skip')
  }
  await writeSkillTarGzip(
    archive,
    Object.entries(files).map(([path, data]) => ({
      path,
      size: data.length,
      executable: path === 'cli-proxy-api',
      bytes: data
    }))
  )
  const raw = gunzipSync(await readFile(archive))
  let offset = 0
  while (raw[offset]) {
    const header = raw.subarray(offset, offset + 512)
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0/g, '').trim(), 8)
    Buffer.from('ustar  \0').copy(header, 257)
    header.fill(0x20, 148, 156)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `).copy(header, 148)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  bytes = gzipSync(raw)
  await writeFile(archive, bytes)
  state.pin.url = 'https://fixture.invalid/archive.tar.gz'
  state.pin.archiveSha256 = createHash('sha256').update(bytes).digest('hex')
  state.pin.archiveBytes = bytes.length
  const input = options()
  const installed = await ensurePinnedEngineAsset(input)
  expect(await readFile(installed.binaryPath, 'utf8')).toBe('synthetic-not-executed')
  expect(await readdir(input.cacheDirectory)).toEqual(['8.0.55-synthetic-x64'])
})
