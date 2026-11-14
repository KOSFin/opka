import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { zipSync } from 'fflate'
import { x as extractTar } from 'tar'

const root = resolve(import.meta.dirname, '../..')
const sourceCommit = 'e6e5708e677adb2463d45accdd24bc9fd028ddd8'
const sourceSha = '45d766358b7e6c453031800af6f1ba6fa1a30bf06a9aca9de8e39141aeaf5b56'
const toolchainSha = 'ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5'
const goBinarySha = '9c2a37ae5b21ba1d5a004bb9ab4d0c64de6fc5778e9d30487adccea62678b8b5'
const patchSha = '88b51a5c4604bd85c366c24ca6aa62c18dcfef1f1d3a76f6b596db38bc8626ab'
const goModSha = '0bde88cb0885b76451e1e000dab3ede1a2e8e37ef9800fe620d3394c1b1df941'
const goSumSha = 'b5ea69a0a029ffd5c0f23ba6893803514a2a4b8ddfb79c223ea2a58d978a654c'
const licenseSha = '879792e89cf1bdd6a8d446033ec87e30496f97dcafc4656dc53f641509b346a6'
const version = `8.0.55-orca-replay-${patchSha.slice(0, 12)}`
const target = process.argv[2]
const sourceArchive = process.argv[3]
const toolchainArchive = process.argv[4]
const outputRoot = process.argv[5]
const moduleCache = process.env.GOMODCACHE
const targetMatch = /^(linux|darwin|win32)-(x64|arm64)$/.exec(target ?? '')
if (
  process.platform !== 'linux' ||
  !targetMatch ||
  [sourceArchive, toolchainArchive, outputRoot, moduleCache].some(
    (path) => !path || !isAbsolute(path)
  )
) {
  throw new Error(
    'Provide a Linux builder and target plus absolute source, toolchain, module cache and output paths.'
  )
}
const [, platform, arch] = targetMatch
const goos = platform === 'win32' ? 'windows' : platform
const goarch = arch === 'x64' ? 'amd64' : 'arm64'
const member = platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api'
const patchPath = join(root, 'config/patches/cli-proxy-api-8.0.55-native-replay.patch')
const manifestPath = join(root, 'config/patches/cli-proxy-api-8.0.55-native-replay.source-sha256')
const licensePath = join(root, 'resources/licenses/cli-proxy-api/LICENSE')

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
async function verified(path, expected) {
  if (hash(await readFile(path)) !== expected) {
    throw new Error(`Pinned build input differs from its SHA256: ${path}`)
  }
}
function command(file, args, cwd, env = process.env) {
  const result = spawnSync(file, args, { cwd, env, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw (
      result.error ?? new Error(`${file} failed (${result.status}): ${result.stderr.slice(-1024)}`)
    )
  }
  return result.stdout
}
await verified(sourceArchive, sourceSha)
await verified(toolchainArchive, toolchainSha)
await verified(patchPath, patchSha)
await verified(licensePath, licenseSha)
const recipeSha256 = hash(await readFile(new URL(import.meta.url)))
const work = await mkdtemp(join(tmpdir(), 'codex-replay-build-'))
try {
  const goRoot = join(work, 'go')
  await mkdir(goRoot)
  await extractTar.asyncFile({ file: toolchainArchive, cwd: goRoot, strip: 1, strict: true }, [])
  const goBinary = join(goRoot, 'bin', 'go')
  await verified(goBinary, goBinarySha)
  const cacheRoot = process.env.ORCA_REPLAY_BUILD_CACHE ?? join(work, 'cache')
  if (!isAbsolute(cacheRoot)) {
    throw new Error('The replay build cache must be an absolute private directory.')
  }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  const cacheMetadata = await lstat(cacheRoot)
  if (
    !cacheMetadata.isDirectory() ||
    cacheMetadata.isSymbolicLink() ||
    cacheMetadata.uid !== process.getuid() ||
    (cacheMetadata.mode & 0o077) !== 0
  ) {
    throw new Error('The replay build cache must belong only to the current builder.')
  }
  await mkdir(join(cacheRoot, 'tmp'), { recursive: true, mode: 0o700 })
  const env = {
    PATH: `${dirname(goBinary)}:/usr/bin:/bin`,
    HOME: work,
    GOROOT: goRoot,
    GOENV: 'off',
    GOEXPERIMENT: '',
    GOTOOLCHAIN: 'local',
    GOWORK: 'off',
    GOPROXY: 'off',
    GOSUMDB: 'off',
    GOCACHE: join(cacheRoot, 'build'),
    GOTMPDIR: join(cacheRoot, 'tmp'),
    TMPDIR: join(cacheRoot, 'tmp'),
    GOMODCACHE: moduleCache,
    GOPATH: join(cacheRoot, 'path'),
    CGO_ENABLED: '0',
    GOOS: goos,
    GOARCH: goarch,
    GOFLAGS: '-p=1 -mod=readonly',
    GOMAXPROCS: '2',
    GOMEMLIMIT: '512MiB'
  }
  const results = []
  for (const name of ['first', 'second']) {
    const buildRoot = join(work, name)
    await mkdir(buildRoot)
    await extractTar.asyncFile({ file: sourceArchive, cwd: buildRoot, strip: 1, strict: true }, [])
    await verified(join(buildRoot, 'go.mod'), goModSha)
    await verified(join(buildRoot, 'go.sum'), goSumSha)
    command('patch', ['-s', '-p1', '-i', patchPath], buildRoot)
    for (const line of (await readFile(manifestPath, 'utf8')).trim().split('\n')) {
      const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line)
      if (!match) {
        throw new Error('Pinned patched source manifest is invalid.')
      }
      await verified(join(buildRoot, match[2]), match[1])
    }
    const binary = join(buildRoot, member)
    command(goBinary, ['mod', 'verify'], buildRoot, env)
    if (name === 'first' && platform === process.platform && arch === process.arch) {
      const tests = command(
        goBinary,
        ['test', '-count=1', '-v', './sdk/cliproxy/executor', '-run', 'Seekable'],
        buildRoot,
        env
      )
      console.log(tests.trim())
    }
    command(
      goBinary,
      [
        'build',
        '-trimpath',
        '-buildvcs=false',
        `-ldflags=-s -w -X main.Version=${version} -X main.Commit=${sourceCommit}`,
        '-o',
        binary,
        './cmd/server/'
      ],
      buildRoot,
      env
    )
    results.push(await readFile(binary))
  }
  const [first, second] = results
  if (hash(first) !== hash(second)) {
    throw new Error('Two distinct build roots produced different unsigned engine bytes.')
  }
  const license = await readFile(licensePath)
  const timestamp = new Date('1980-01-01T00:00:00.000Z')
  const archive = (binary) =>
    zipSync(
      {
        [member]: [binary, { os: 3, attrs: 0o100700 << 16, mtime: timestamp }],
        LICENSE: [license, { os: 3, attrs: 0o100600 << 16, mtime: timestamp }]
      },
      { level: 0, mtime: timestamp }
    )
  const zip = archive(first)
  if (hash(zip) !== hash(archive(second))) {
    throw new Error('Two distinct build roots produced different normalized archives.')
  }
  await mkdir(outputRoot, { recursive: true })
  const stage = await mkdtemp(join(outputRoot, '.replay-target-'))
  try {
    await writeFile(join(stage, 'engine.zip'), zip, { flag: 'wx' })
    await writeFile(join(stage, member), first, { flag: 'wx', mode: 0o700 })
    await writeFile(
      join(stage, 'manifest.json'),
      JSON.stringify({
        schema: 1,
        target,
        version,
        sourceCommit,
        sourceArchiveSha256: sourceSha,
        patchSha256: patchSha,
        goModSha256: goModSha,
        goSumSha256: goSumSha,
        goVersion: '1.26.10',
        toolchainArchiveSha256: toolchainSha,
        recipeSha256,
        licenseSha256: licenseSha,
        unsignedBinarySha256: hash(first),
        archiveSha256: hash(zip),
        archiveBytes: zip.length,
        binarySha256: hash(first),
        binaryBytes: first.length
      }),
      { flag: 'wx' }
    )
    await rename(stage, join(outputRoot, target))
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  console.log(
    JSON.stringify({
      target,
      unsignedBinarySha256: hash(first),
      archiveSha256: hash(zip),
      recipeSha256
    })
  )
} finally {
  await rm(work, { recursive: true, force: true })
}
