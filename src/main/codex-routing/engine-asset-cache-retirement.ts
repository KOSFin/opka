import { lstat, readFile, readdir, rm } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import type { EngineAssetCacheOptions } from './engine-asset-cache'
import { EngineAssetCacheReceipt, digestEngineAssetFile } from './engine-asset-cache-integrity'
import { ENGINE_LICENSE_SHA256, type EngineAssetPin } from './engine-asset-pin'

type Version = {
  directory: string
  installedAt: number
  identities: { path: string; stat: Stats }[]
}
const owned = (stat: Stats, uid: number): boolean =>
  stat.uid === uid && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0

async function verifiedVersion(
  directory: string,
  name: string,
  pin: EngineAssetPin,
  uid: number,
  signal: AbortSignal
): Promise<Version | null> {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || !owned(stat, uid)) {
    return null
  }
  const files = ['LICENSE', pin.binaryMember, 'receipt.json'].sort()
  if ((await readdir(directory)).sort().join('\n') !== files.join('\n')) {
    return null
  }
  const identities = [{ path: directory, stat }]
  for (const file of files) {
    const path = join(directory, file)
    const metadata = await lstat(path)
    if (!metadata.isFile() || !owned(metadata, uid)) {
      return null
    }
    identities.push({ path, stat: metadata })
  }
  const receiptFile = identities.find((entry) => entry.path === join(directory, 'receipt.json'))
  const binaryFile = identities.find((entry) => entry.path === join(directory, pin.binaryMember))
  const licenseFile = identities.find((entry) => entry.path === join(directory, 'LICENSE'))
  if (
    !receiptFile ||
    !binaryFile ||
    !licenseFile ||
    receiptFile.stat.size > 4096 ||
    licenseFile.stat.size > 65536
  ) {
    return null
  }
  const receipt = EngineAssetCacheReceipt.parse(
    JSON.parse(await readFile(receiptFile.path, 'utf8'))
  )
  if (
    receipt.target !== pin.target ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(receipt.version) ||
    name !== `${receipt.version}-${receipt.target}` ||
    !/^[a-f0-9]{64}$/.test(receipt.archiveSha256) ||
    !Number.isSafeInteger(receipt.archiveBytes) ||
    receipt.archiveBytes <= 0 ||
    receipt.archiveBytes > 128 * 1024 * 1024 ||
    binaryFile.stat.size !== receipt.binaryBytes ||
    (await digestEngineAssetFile(binaryFile.path, signal)) !== receipt.binarySha256 ||
    (await digestEngineAssetFile(licenseFile.path, signal)) !== ENGINE_LICENSE_SHA256
  ) {
    return null
  }
  return { directory, installedAt: receiptFile.stat.mtimeMs, identities }
}

async function assertUnchanged(version: Version): Promise<void> {
  for (const entry of version.identities) {
    const current = await lstat(entry.path)
    if (
      current.isSymbolicLink() ||
      current.dev !== entry.stat.dev ||
      current.ino !== entry.stat.ino ||
      current.size !== entry.stat.size ||
      current.mtimeMs !== entry.stat.mtimeMs ||
      current.ctimeMs !== entry.stat.ctimeMs ||
      current.uid !== entry.stat.uid ||
      current.mode !== entry.stat.mode
    ) {
      throw new Error(
        'Routing engine cache changed during retirement; remaining versions were preserved'
      )
    }
  }
}

/** Retain current plus one rollback; unknown entries and unproven owners are never removed. */
export async function retireEngineAssetCacheVersions(
  options: Pick<
    EngineAssetCacheOptions,
    'cacheDirectory' | 'assertExclusiveInstallLease' | 'assertCanReplaceInstalledBinary'
  >,
  pin: EngineAssetPin,
  signal: AbortSignal
): Promise<void> {
  if (typeof process.getuid !== 'function') {
    return
  }
  const uid = process.getuid()
  options.assertExclusiveInstallLease()
  const root = await lstat(options.cacheDirectory)
  if (!root.isDirectory() || !owned(root, uid)) {
    throw new Error('Routing engine cache ownership is unverifiable; versions were preserved')
  }
  const current = `${pin.version}-${pin.target}`
  const versions: Version[] = []
  for (const name of await readdir(options.cacheDirectory)) {
    signal.throwIfAborted()
    if (name === current || name === '.install') {
      continue
    }
    try {
      const version = await verifiedVersion(
        join(options.cacheDirectory, name),
        name,
        pin,
        uid,
        signal
      )
      if (version) {
        versions.push(version)
      }
    } catch {
      signal.throwIfAborted()
      // Unknown, damaged or unreadable entries remain for their owning host to inspect.
    }
  }
  versions.sort(
    (left, right) =>
      right.installedAt - left.installedAt || right.directory.localeCompare(left.directory)
  )
  const retired = versions.slice(1)
  for (const version of retired) {
    options.assertExclusiveInstallLease()
    options.assertCanReplaceInstalledBinary(version.directory)
    await assertUnchanged(version)
  }
  for (const version of retired) {
    signal.throwIfAborted()
    options.assertExclusiveInstallLease()
    options.assertCanReplaceInstalledBinary(version.directory)
    await assertUnchanged(version)
    await rm(version.directory, { recursive: true })
  }
}
