import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { ensurePinnedEngineAsset, type EngineAssetCacheOptions } from './engine-asset-cache'
import { ENGINE_ASSET_COMMIT, ENGINE_LICENSE_SHA256 } from './engine-asset-pin'

const PATCH_SHA256 = '3bd902df9fa05bbc88c268a4b9d52a0e134f596f9e7ddf299148e2e4780a2fce'
const SOURCE_ARCHIVE_SHA256 = '45d766358b7e6c453031800af6f1ba6fa1a30bf06a9aca9de8e39141aeaf5b56'
const GO_MOD_SHA256 = '0bde88cb0885b76451e1e000dab3ede1a2e8e37ef9800fe620d3394c1b1df941'
const GO_SUM_SHA256 = 'b5ea69a0a029ffd5c0f23ba6893803514a2a4b8ddfb79c223ea2a58d978a654c'
const VERSION = `8.0.55-orca-replay-${PATCH_SHA256.slice(0, 12)}`
const Sha = z.string().regex(/^[a-f0-9]{64}$/)
const Manifest = z.strictObject({
  schema: z.literal(1),
  target: z.enum([
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-arm64',
    'win32-x64'
  ]),
  version: z.literal(VERSION),
  sourceCommit: z.literal(ENGINE_ASSET_COMMIT),
  sourceArchiveSha256: z.literal(SOURCE_ARCHIVE_SHA256),
  patchSha256: z.literal(PATCH_SHA256),
  goModSha256: z.literal(GO_MOD_SHA256),
  goSumSha256: z.literal(GO_SUM_SHA256),
  goVersion: z.literal('1.26.10'),
  toolchainArchiveSha256: Sha,
  recipeSha256: Sha,
  licenseSha256: z.literal(ENGINE_LICENSE_SHA256),
  unsignedBinarySha256: Sha,
  archiveSha256: Sha,
  archiveBytes: z
    .number()
    .int()
    .positive()
    .max(128 * 1024 * 1024),
  binarySha256: Sha,
  binaryBytes: z
    .number()
    .int()
    .positive()
    .max(120 * 1024 * 1024)
})

/** The surrounding packaged app signature protects this manifest, not the mutable cache receipt. */
export async function readPackagedReplayEngineAsset(
  resourceRoot: string,
  target: string
): Promise<NonNullable<EngineAssetCacheOptions['packaged']>> {
  if (!isAbsolute(resourceRoot) || !/^(?:darwin|linux|win32)-(?:arm64|x64)$/.test(target)) {
    throw new Error('Native replay package execution-host target is invalid.')
  }
  const directory = join(resourceRoot, 'codex-routing-replay', target)
  const metadata = await lstat(directory)
  const manifestPath = join(directory, 'manifest.json')
  const manifestFile = await lstat(manifestPath)
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !manifestFile.isFile() ||
    manifestFile.isSymbolicLink() ||
    manifestFile.size > 4096
  ) {
    throw new Error('Protected native replay manifest is unavailable.')
  }
  const manifest = Manifest.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  if (manifest.target !== target) {
    throw new Error('Protected native replay manifest has another execution-host target.')
  }
  const binaryMember = target.startsWith('win32-') ? 'cli-proxy-api.exe' : 'cli-proxy-api'
  return {
    archivePath: join(directory, 'engine.zip'),
    binarySha256: manifest.binarySha256,
    pin: {
      target,
      version: manifest.version,
      url: '',
      archiveSha256: manifest.archiveSha256,
      archiveBytes: manifest.archiveBytes,
      binaryMember
    }
  }
}

/** Missing or wrong target assets fail before the account route can open provider traffic. */
export async function ensurePackagedReplayEngineAsset(options: EngineAssetCacheOptions) {
  const resourceRoot = process.resourcesPath
  if (!resourceRoot) {
    throw new Error('Native replay asset is not installed on this execution host.')
  }
  const packaged = await readPackagedReplayEngineAsset(
    resourceRoot,
    `${options.platform ?? process.platform}-${options.arch ?? process.arch}`
  )
  return ensurePinnedEngineAsset({ ...options, packaged })
}
