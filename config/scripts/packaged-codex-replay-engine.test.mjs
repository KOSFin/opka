import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  assertReplayArtifact,
  finalizeReplayArtifact,
  stageReplayArtifact
} = require('./packaged-codex-replay-engine.cjs')
const license = await readFile(
  new URL('../../resources/licenses/cli-proxy-api/LICENSE', import.meta.url)
)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
let root
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = undefined
})

async function packageFixture(target) {
  root = await mkdtemp(join(tmpdir(), 'synthetic-replay-package-'))
  const directory = join(root, target)
  await mkdir(directory)
  const binary = Buffer.alloc(512)
  if (target.startsWith('linux-')) {
    binary.write('\x7fELF', 0, 'binary')
    binary[4] = 2
    binary[5] = 1
    binary.writeUInt16LE(target.endsWith('x64') ? 62 : 183, 18)
  } else {
    binary.writeUInt32LE(0xfeedfacf, 0)
    binary.writeUInt32LE(target.endsWith('x64') ? 0x01000007 : 0x0100000c, 4)
  }
  const timestamp = new Date('1980-01-01T00:00:00.000Z')
  const archive = zipSync(
    {
      'cli-proxy-api': [binary, { os: 3, attrs: 0o100700 << 16, mtime: timestamp }],
      LICENSE: [license, { os: 3, attrs: 0o100600 << 16, mtime: timestamp }]
    },
    { level: 0, mtime: timestamp }
  )
  const manifest = {
    schema: 1,
    target,
    version: '8.0.55-orca-replay-3bd902df9fa0',
    sourceCommit: 'e6e5708e677adb2463d45accdd24bc9fd028ddd8',
    sourceArchiveSha256: '45d766358b7e6c453031800af6f1ba6fa1a30bf06a9aca9de8e39141aeaf5b56',
    patchSha256: '3bd902df9fa05bbc88c268a4b9d52a0e134f596f9e7ddf299148e2e4780a2fce',
    goModSha256: '0bde88cb0885b76451e1e000dab3ede1a2e8e37ef9800fe620d3394c1b1df941',
    goSumSha256: 'b5ea69a0a029ffd5c0f23ba6893803514a2a4b8ddfb79c223ea2a58d978a654c',
    goVersion: '1.26.10',
    toolchainArchiveSha256: 'a'.repeat(64),
    recipeSha256: 'b'.repeat(64),
    licenseSha256: sha(license),
    unsignedBinarySha256: sha(binary),
    archiveSha256: sha(archive),
    archiveBytes: archive.length,
    binarySha256: sha(binary),
    binaryBytes: binary.length
  }
  await writeFile(join(directory, 'cli-proxy-api'), binary)
  await writeFile(join(directory, 'engine.zip'), archive)
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  return { directory, manifest }
}

it('rejects a missing, wrong-host, tampered or wrong-source packaged replay artifact', async () => {
  const { directory, manifest } = await packageFixture('linux-x64')
  expect(assertReplayArtifact(directory, 'linux-x64').manifest).toEqual(manifest)
  expect(() => assertReplayArtifact(directory, 'linux-arm64')).toThrow('provenance')
  manifest.patchSha256 = '0'.repeat(64)
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  expect(() => assertReplayArtifact(directory, 'linux-x64')).toThrow('provenance')
  manifest.patchSha256 = '3bd902df9fa05bbc88c268a4b9d52a0e134f596f9e7ddf299148e2e4780a2fce'
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(directory, 'engine.zip'), 'damaged')
  expect(() => assertReplayArtifact(directory, 'linux-x64')).toThrow('byte count')
  expect(() => assertReplayArtifact(join(root, 'missing'), 'linux-x64')).toThrow('missing')
})

it('records final Mac signed bytes before the outer app is sealed', async () => {
  const { directory, manifest } = await packageFixture('darwin-arm64')
  await finalizeReplayArtifact(directory, 'darwin-arm64', async (path) => {
    const original = await readFile(path)
    await writeFile(path, Buffer.concat([original, Buffer.from('synthetic-signature')]))
  })
  const final = assertReplayArtifact(directory, 'darwin-arm64').manifest
  expect(final.unsignedBinarySha256).toBe(manifest.unsignedBinarySha256)
  expect(final.binarySha256).not.toBe(final.unsignedBinarySha256)
})

it.skipIf(process.platform === 'win32')(
  'refuses a link in a purported protected package',
  async () => {
    const { directory } = await packageFixture('linux-x64')
    await rm(join(directory, 'engine.zip'))
    await symlink(join(directory, 'cli-proxy-api'), join(directory, 'engine.zip'))
    expect(() => assertReplayArtifact(directory, 'linux-x64')).toThrow('link')
  }
)

it('copies the verified Linux replay triple into the installed server resource root', async () => {
  const { directory, manifest } = await packageFixture('linux-x64')
  const resources = join(root, 'installed-orcad')
  const installed = stageReplayArtifact(directory, resources, 'linux-x64')
  expect(installed).toBe(join(resources, 'codex-routing-replay', 'linux-x64'))
  await rm(directory, { recursive: true })
  expect(assertReplayArtifact(installed, 'linux-x64').manifest).toEqual(manifest)
  expect(await readFile(join(installed, 'manifest.json'), 'utf8')).toBe(JSON.stringify(manifest))
})

it('fails before staging a missing or mismatched replay artifact', async () => {
  const { directory } = await packageFixture('linux-x64')
  const resources = join(root, 'installed-orcad')
  expect(() => stageReplayArtifact(directory, resources, 'linux-arm64')).toThrow('provenance')
  expect(() => stageReplayArtifact(join(root, 'missing'), resources, 'linux-x64')).toThrow(
    'missing'
  )
})

it.skipIf(process.platform === 'win32')(
  'rejects a dangling destination link without writing outside the package',
  async () => {
    const { directory } = await packageFixture('linux-x64')
    const resources = join(root, 'installed-orcad')
    const installed = join(resources, 'codex-routing-replay', 'linux-x64')
    const outside = join(root, 'outside-engine')
    await mkdir(installed, { recursive: true })
    await symlink(outside, join(installed, 'cli-proxy-api'))
    expect(() => stageReplayArtifact(directory, resources, 'linux-x64')).toThrow('link')
    await expect(readFile(outside)).rejects.toMatchObject({ code: 'ENOENT' })
  }
)
