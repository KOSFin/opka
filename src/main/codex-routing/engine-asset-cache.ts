import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { getMainHttpClient, type MainHttpClient } from '../network/http-client'
import { downloadVerifiedArchive } from '../node-runtime/runtime-archive-download'
import { ENGINE_LICENSE_SHA256, getEngineAssetPin } from './engine-asset-pin'
import { extractEngineAsset } from './engine-asset-extraction'

export type EngineAssetCacheOptions = {
  cacheDirectory: string
  platform?: string
  arch?: string
  signal?: AbortSignal
  fetcher?: MainHttpClient['fetch']
  /** Host-owned install lease excludes every previous/concurrent writer, including crash recovery. */
  assertExclusiveInstallLease: () => void
  /** The host must prove no live or unverifiable engine uses a damaged/old installed directory. */
  assertCanReplaceInstalledBinary: (directory: string) => void
}
const Receipt = z.object({
  archiveSha256: z.string(),
  archiveBytes: z.number(),
  target: z.string(),
  version: z.string(),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  binaryBytes: z
    .number()
    .int()
    .positive()
    .max(120 * 1024 * 1024)
})
async function digest(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}
async function existing(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
    return null
  }
}
async function ownedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
  ) {
    throw new Error('Routing engine cache is not an owned directory')
  }
  if (process.platform !== 'win32') {
    await chmod(path, 0o700)
  }
}

/** Explicit provisioning only. Never starts an engine, imports auth or changes runtime installations. */
export async function ensurePinnedEngineAsset(options: EngineAssetCacheOptions) {
  const signal = options.signal ?? new AbortController().signal
  const pin = getEngineAssetPin(options.platform, options.arch)
  const root = options.cacheDirectory
  if (!isAbsolute(root)) {
    throw new Error('Routing engine cache path must be absolute')
  }
  options.assertExclusiveInstallLease()
  signal.throwIfAborted()
  await ownedDirectory(root)
  const destination = join(root, `${pin.version}-${pin.target}`)
  const staging = join(root, '.install')
  const names = await readdir(root)
  for (const name of names) {
    if (name === '.install' || name === `${pin.version}-${pin.target}`) {
      continue
    }
    // Unknown/older copies can remain in use; this component does not prune their lifetime.
    throw new Error(
      'Routing engine cache contains another version; retire it through its owning host first'
    )
  }
  const stage = await existing(staging)
  if (stage && (!stage.isDirectory() || stage.isSymbolicLink())) {
    throw new Error('Routing engine staging path is not a regular directory')
  }
  options.assertExclusiveInstallLease()
  await rm(staging, { recursive: true, force: true })
  const binaryPath = join(destination, pin.binaryMember)
  const installed = await existing(destination)
  if (installed && (!installed.isDirectory() || installed.isSymbolicLink())) {
    throw new Error('Routing engine release path is not a regular directory')
  }
  if (installed) {
    try {
      const receiptPath = join(destination, 'receipt.json')
      const receiptStat = await lstat(receiptPath)
      if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > 4096) {
        throw new Error('Invalid engine receipt')
      }
      const receipt = Receipt.parse(JSON.parse(await readFile(receiptPath, 'utf8')))
      const file = await lstat(binaryPath),
        license = await lstat(join(destination, 'LICENSE'))
      if (
        receipt.archiveSha256 !== pin.archiveSha256 ||
        receipt.archiveBytes !== pin.archiveBytes ||
        receipt.target !== pin.target ||
        receipt.version !== pin.version ||
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.size !== receipt.binaryBytes ||
        !license.isFile() ||
        license.isSymbolicLink() ||
        license.size > 65536 ||
        (await digest(binaryPath, signal)) !== receipt.binarySha256 ||
        (await digest(join(destination, 'LICENSE'), signal)) !== ENGINE_LICENSE_SHA256
      ) {
        throw new Error('Damaged engine cache')
      }
      return {
        binaryPath,
        expectedSha256: receipt.binarySha256,
        archiveSha256: pin.archiveSha256,
        version: pin.version,
        reused: true
      }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof Error && 'code' in error && !isDefinitiveAbsence(error)) {
        throw error
      }
      options.assertCanReplaceInstalledBinary(destination)
    }
  }
  try {
    await ownedDirectory(staging)
    const release = join(staging, 'release')
    await ownedDirectory(release)
    const archive = join(
      staging,
      pin.url.endsWith('.zip') ? 'archive.part.zip' : 'archive.part.tar.gz'
    )
    await downloadVerifiedArchive(
      {
        label: 'Routing engine',
        url: pin.url,
        archiveSha256: pin.archiveSha256,
        maxArchiveBytes: pin.archiveBytes
      },
      archive,
      options.fetcher ?? getMainHttpClient().fetch,
      signal,
      []
    )
    if ((await stat(archive)).size !== pin.archiveBytes) {
      throw new Error('Routing engine archive byte count differs from its pin')
    }
    await extractEngineAsset(archive, release, pin.binaryMember, signal)
    if ((await digest(join(release, 'LICENSE'), signal)) !== ENGINE_LICENSE_SHA256) {
      throw new Error('Routing engine MIT license does not match the pinned release')
    }
    const binary = join(release, pin.binaryMember)
    const binarySha256 = await digest(binary, signal)
    const binaryBytes = (await stat(binary)).size
    if (process.platform !== 'win32') {
      await chmod(binary, 0o700)
      await chmod(join(release, 'LICENSE'), 0o600)
    }
    await writeFile(
      join(release, 'receipt.json'),
      JSON.stringify({
        archiveSha256: pin.archiveSha256,
        archiveBytes: pin.archiveBytes,
        target: pin.target,
        version: pin.version,
        binarySha256,
        binaryBytes
      }),
      { flag: 'wx', mode: 0o600 }
    )
    options.assertExclusiveInstallLease()
    signal.throwIfAborted()
    if (installed) {
      options.assertCanReplaceInstalledBinary(destination)
      await rename(destination, join(staging, 'retired'))
    }
    await rename(release, destination)
    return {
      binaryPath,
      expectedSha256: binarySha256,
      archiveSha256: pin.archiveSha256,
      version: pin.version,
      reused: false
    }
  } finally {
    options.assertExclusiveInstallLease()
    await rm(staging, { recursive: true, force: true })
  }
}
