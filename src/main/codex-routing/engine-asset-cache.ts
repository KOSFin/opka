import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { getMainHttpClient, type MainHttpClient } from '../network/http-client'
import { downloadVerifiedArchive } from '../node-runtime/runtime-archive-download'
import { ENGINE_LICENSE_SHA256, getEngineAssetPin, type EngineAssetPin } from './engine-asset-pin'
import { extractEngineAsset } from './engine-asset-extraction'
import {
  EngineAssetCacheReceipt,
  digestEngineAssetFile as digest
} from './engine-asset-cache-integrity'
import { retireEngineAssetCacheVersions } from './engine-asset-cache-retirement'
import { assertEngineAssetTargetFormat } from './engine-asset-target-format'

export type EngineAssetCacheOptions = {
  cacheDirectory: string
  platform?: string
  arch?: string
  signal?: AbortSignal
  fetcher?: MainHttpClient['fetch']
  /** A protected package manifest supplies the patched source identity and final binary pin. */
  packaged?: { pin: EngineAssetPin; archivePath: string; binarySha256: string }
  /** Host-owned install lease excludes every previous/concurrent writer, including crash recovery. */
  assertExclusiveInstallLease: () => void
  /** The host must prove no live or unverifiable engine uses a damaged/old installed directory. */
  assertCanReplaceInstalledBinary: (directory: string) => void
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
  options.assertExclusiveInstallLease()
  const pin = options.packaged?.pin ?? getEngineAssetPin(options.platform, options.arch)
  if (options.packaged) {
    if (
      pin.target !== `${options.platform ?? process.platform}-${options.arch ?? process.arch}` ||
      !isAbsolute(options.packaged.archivePath) ||
      !/^[a-f0-9]{64}$/.test(options.packaged.binarySha256)
    ) {
      throw new Error('Packaged routing engine target or protected pin is invalid')
    }
    const source = await lstat(options.packaged.archivePath)
    if (!source.isFile() || source.isSymbolicLink() || source.size !== pin.archiveBytes) {
      throw new Error('Packaged routing engine archive is missing or has the wrong byte count')
    }
    if ((await digest(options.packaged.archivePath, signal)) !== pin.archiveSha256) {
      throw new Error('Packaged routing engine archive does not match its protected pin')
    }
  }
  const root = options.cacheDirectory
  if (!isAbsolute(root)) {
    throw new Error('Routing engine cache path must be absolute')
  }
  signal.throwIfAborted()
  await ownedDirectory(root)
  const destination = join(root, `${pin.version}-${pin.target}`)
  const staging = join(root, '.install')
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
  let reused:
    | {
        binaryPath: string
        expectedSha256: string
        archiveSha256: string
        version: string
        reused: boolean
      }
    | undefined
  if (installed) {
    try {
      const receiptPath = join(destination, 'receipt.json')
      const receiptStat = await lstat(receiptPath)
      if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > 4096) {
        throw new Error('Invalid engine receipt')
      }
      const receipt = EngineAssetCacheReceipt.parse(JSON.parse(await readFile(receiptPath, 'utf8')))
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
        (options.packaged && receipt.binarySha256 !== options.packaged.binarySha256) ||
        !license.isFile() ||
        license.isSymbolicLink() ||
        license.size > 65536 ||
        (await digest(binaryPath, signal)) !== receipt.binarySha256 ||
        (await digest(join(destination, 'LICENSE'), signal)) !== ENGINE_LICENSE_SHA256
      ) {
        throw new Error('Damaged engine cache')
      }
      if (options.packaged) {
        await assertEngineAssetTargetFormat(binaryPath, pin.target)
      }
      reused = {
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
  if (reused) {
    await retireEngineAssetCacheVersions(options, pin, signal)
    return reused
  }
  try {
    await ownedDirectory(staging)
    const release = join(staging, 'release')
    await ownedDirectory(release)
    const archive = join(
      staging,
      (options.packaged?.archivePath ?? pin.url).endsWith('.zip')
        ? 'archive.part.zip'
        : 'archive.part.tar.gz'
    )
    if (options.packaged) {
      await copyFile(options.packaged.archivePath, archive)
      if ((await digest(archive, signal)) !== pin.archiveSha256) {
        throw new Error('Packaged routing engine archive does not match its protected pin')
      }
    } else {
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
    }
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
    if (options.packaged) {
      if (binarySha256 !== options.packaged.binarySha256) {
        throw new Error('Packaged routing engine binary does not match its protected pin')
      }
      await assertEngineAssetTargetFormat(binary, pin.target)
    }
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
    await retireEngineAssetCacheVersions(options, pin, signal)
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
