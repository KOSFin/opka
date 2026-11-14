const { createHash } = require('node:crypto')
const {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} = require('node:fs')
const { join } = require('node:path')
const { unzipSync, zipSync } = require('fflate')

const SOURCE_COMMIT = 'e6e5708e677adb2463d45accdd24bc9fd028ddd8'
const SOURCE_SHA = '45d766358b7e6c453031800af6f1ba6fa1a30bf06a9aca9de8e39141aeaf5b56'
const PATCH_SHA = '88b51a5c4604bd85c366c24ca6aa62c18dcfef1f1d3a76f6b596db38bc8626ab'
const MOD_SHA = '0bde88cb0885b76451e1e000dab3ede1a2e8e37ef9800fe620d3394c1b1df941'
const SUM_SHA = 'b5ea69a0a029ffd5c0f23ba6893803514a2a4b8ddfb79c223ea2a58d978a654c'
const LICENSE_SHA = '879792e89cf1bdd6a8d446033ec87e30496f97dcafc4656dc53f641509b346a6'
const VERSION = `8.0.55-orca-replay-${PATCH_SHA.slice(0, 12)}`
const ZERO_TIME = new Date('1980-01-01T00:00:00.000Z')

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
function binaryMember(target) {
  return target.startsWith('win32-') ? 'cli-proxy-api.exe' : 'cli-proxy-api'
}
function archive(binary, license, target) {
  return zipSync(
    {
      [binaryMember(target)]: [binary, { os: 3, attrs: 0o100700 << 16, mtime: ZERO_TIME }],
      LICENSE: [license, { os: 3, attrs: 0o100600 << 16, mtime: ZERO_TIME }]
    },
    { level: 0, mtime: ZERO_TIME }
  )
}
function assertFormat(bytes, target) {
  const [platform, arch] = target.split('-')
  let valid = false
  if (platform === 'linux' && bytes.length >= 20) {
    valid =
      bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      bytes[4] === 2 &&
      bytes[5] === 1 &&
      bytes.readUInt16LE(18) === (arch === 'x64' ? 62 : arch === 'arm64' ? 183 : -1)
  } else if (platform === 'darwin' && bytes.length >= 8) {
    valid =
      bytes.readUInt32LE(0) === 0xfeedfacf &&
      bytes.readUInt32LE(4) === (arch === 'x64' ? 0x01000007 : arch === 'arm64' ? 0x0100000c : -1)
  } else if (platform === 'win32' && bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ') {
    const offset = bytes.readUInt32LE(0x3c)
    valid =
      offset + 6 <= bytes.length &&
      bytes.toString('ascii', offset, offset + 4) === 'PE\0\0' &&
      bytes.readUInt16LE(offset + 4) === (arch === 'x64' ? 0x8664 : arch === 'arm64' ? 0xaa64 : -1)
  }
  if (!valid) {
    throw new Error(`Native replay engine target format differs: ${target}`)
  }
}
function assertReplayArtifact(directory, target) {
  if (!/^(?:linux|darwin)-(?:x64|arm64)$/.test(target) || !existsSync(directory)) {
    throw new Error(`Native replay engine asset is missing for ${target}`)
  }
  const manifestPath = join(directory, 'manifest.json')
  const paths = [
    directory,
    manifestPath,
    join(directory, binaryMember(target)),
    join(directory, 'engine.zip')
  ]
  const [folder, manifestFile, binaryFile, archiveFile] = paths.map((path) => lstatSync(path))
  if (
    !folder.isDirectory() ||
    folder.isSymbolicLink() ||
    [manifestFile, binaryFile, archiveFile].some(
      (entry) => !entry.isFile() || entry.isSymbolicLink()
    )
  ) {
    throw new Error('Native replay package contains a link or non-file resource')
  }
  if (manifestFile.size > 4096) {
    throw new Error('Native replay manifest is oversized')
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (
    manifest.schema !== 1 ||
    manifest.target !== target ||
    manifest.version !== VERSION ||
    manifest.sourceCommit !== SOURCE_COMMIT ||
    manifest.sourceArchiveSha256 !== SOURCE_SHA ||
    manifest.patchSha256 !== PATCH_SHA ||
    manifest.goModSha256 !== MOD_SHA ||
    manifest.goSumSha256 !== SUM_SHA ||
    manifest.goVersion !== '1.26.10' ||
    manifest.licenseSha256 !== LICENSE_SHA ||
    !/^[a-f0-9]{64}$/.test(manifest.toolchainArchiveSha256) ||
    !/^[a-f0-9]{64}$/.test(manifest.recipeSha256) ||
    !/^[a-f0-9]{64}$/.test(manifest.unsignedBinarySha256) ||
    !Number.isSafeInteger(manifest.binaryBytes) ||
    manifest.binaryBytes < 1 ||
    manifest.binaryBytes > 120 * 1024 * 1024 ||
    !Number.isSafeInteger(manifest.archiveBytes) ||
    manifest.archiveBytes < 1 ||
    manifest.archiveBytes > 128 * 1024 * 1024
  ) {
    throw new Error('Native replay manifest has wrong source provenance')
  }
  if (binaryFile.size !== manifest.binaryBytes || archiveFile.size !== manifest.archiveBytes) {
    throw new Error('Native replay package byte count differs from protected manifest')
  }
  const binary = readFileSync(join(directory, binaryMember(target)))
  const zipped = readFileSync(join(directory, 'engine.zip'))
  if (
    sha(binary) !== manifest.binarySha256 ||
    binary.length !== manifest.binaryBytes ||
    sha(zipped) !== manifest.archiveSha256 ||
    zipped.length !== manifest.archiveBytes
  ) {
    throw new Error('Native replay package bytes differ from protected manifest')
  }
  assertFormat(binary, target)
  const unpacked = unzipSync(zipped)
  if (
    Object.keys(unpacked).sort().join(',') !== ['LICENSE', binaryMember(target)].sort().join(',') ||
    !unpacked[binaryMember(target)] ||
    !unpacked.LICENSE ||
    sha(unpacked[binaryMember(target)]) !== manifest.binarySha256 ||
    sha(unpacked.LICENSE) !== LICENSE_SHA
  ) {
    throw new Error('Native replay archive content differs from protected manifest')
  }
  return { manifest, binary }
}

function stageReplayArtifact(source, resourceRoot, target) {
  assertReplayArtifact(source, target)
  const parent = join(resourceRoot, 'codex-routing-replay')
  for (const directory of [resourceRoot, parent]) {
    mkdirSync(directory, { recursive: true })
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Native replay package destination is not a regular directory')
    }
  }
  const destination = join(parent, target)
  mkdirSync(destination, { recursive: true })
  const metadata = lstatSync(destination)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Native replay package destination is not a regular directory')
  }
  for (const name of [binaryMember(target), 'engine.zip', 'manifest.json']) {
    const file = join(destination, name)
    const current = lstatSync(file, { throwIfNoEntry: false })
    if (current && (!current.isFile() || current.isSymbolicLink())) {
      throw new Error('Native replay package destination contains a link or non-file resource')
    }
    copyFileSync(join(source, name), file)
  }
  assertReplayArtifact(destination, target)
  return destination
}

async function finalizeReplayArtifact(directory, target, signMacBinary) {
  const { manifest } = assertReplayArtifact(directory, target)
  if (target.startsWith('darwin-')) {
    await signMacBinary(join(directory, binaryMember(target)))
    const binary = readFileSync(join(directory, binaryMember(target)))
    assertFormat(binary, target)
    const zipped = archive(
      binary,
      readFileSync(join(__dirname, '../../resources/licenses/cli-proxy-api/LICENSE')),
      target
    )
    manifest.binarySha256 = sha(binary)
    manifest.binaryBytes = binary.length
    manifest.archiveSha256 = sha(zipped)
    manifest.archiveBytes = zipped.length
    writeFileSync(join(directory, 'engine.zip'), zipped)
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
  }
  assertReplayArtifact(directory, target)
}

module.exports = { assertReplayArtifact, finalizeReplayArtifact, stageReplayArtifact }
