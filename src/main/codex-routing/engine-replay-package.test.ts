import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ENGINE_ASSET_COMMIT, ENGINE_LICENSE_SHA256 } from './engine-asset-pin'
import {
  readPackagedReplayEngineAsset,
  resolveReplayEngineResourceRoot
} from './engine-replay-package'

let root: string | undefined
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

it('requires the patched source, dependency and execution-host identity in the protected manifest', async () => {
  root = await mkdtemp(join(tmpdir(), 'synthetic-replay-package-'))
  const directory = join(root, 'codex-routing-replay', 'linux-x64')
  await mkdir(directory, { recursive: true })
  const manifest = {
    schema: 1,
    target: 'linux-x64',
    version: '8.0.55-orca-replay-3bd902df9fa0',
    sourceCommit: ENGINE_ASSET_COMMIT,
    sourceArchiveSha256: '45d766358b7e6c453031800af6f1ba6fa1a30bf06a9aca9de8e39141aeaf5b56',
    patchSha256: '3bd902df9fa05bbc88c268a4b9d52a0e134f596f9e7ddf299148e2e4780a2fce',
    goModSha256: '0bde88cb0885b76451e1e000dab3ede1a2e8e37ef9800fe620d3394c1b1df941',
    goSumSha256: 'b5ea69a0a029ffd5c0f23ba6893803514a2a4b8ddfb79c223ea2a58d978a654c',
    goVersion: '1.26.10',
    toolchainArchiveSha256: 'a'.repeat(64),
    recipeSha256: 'b'.repeat(64),
    licenseSha256: ENGINE_LICENSE_SHA256,
    unsignedBinarySha256: 'c'.repeat(64),
    archiveSha256: 'd'.repeat(64),
    archiveBytes: 123,
    binarySha256: 'e'.repeat(64),
    binaryBytes: 456
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  const asset = await readPackagedReplayEngineAsset(root, 'linux-x64')
  expect(asset.pin.version).toBe(manifest.version)
  expect(asset.pin.archiveSha256).toBe(manifest.archiveSha256)
  expect(asset.binarySha256).toBe(manifest.binarySha256)
  await expect(readPackagedReplayEngineAsset(root, 'linux-arm64')).rejects.toThrow()

  manifest.patchSha256 = '0'.repeat(64)
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  await expect(readPackagedReplayEngineAsset(root, 'linux-x64')).rejects.toThrow()
})

it('uses the immutable server bundle directory on a Node host without Electron resources', () => {
  const bundle = join(tmpdir(), 'synthetic-orcad-resources')
  const electron = join(tmpdir(), 'synthetic-electron-resources')
  expect(resolveReplayEngineResourceRoot('', join(bundle, 'orcad.js'))).toBe(bundle)
  expect(resolveReplayEngineResourceRoot(electron, join(bundle, 'orcad.js'))).toBe(electron)
})
