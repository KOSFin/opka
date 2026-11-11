import { afterEach, expect, it as vitestIt } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { prepareCodexNativeHome } from './codex-native-home'
import { recoverCodexNativeHomeConfig } from './codex-native-home-recovery'
import { nativeHomeDigest } from './codex-native-home-inputs'
import { CodexNativeHomeManifestSchema } from './codex-native-home-manifest'
import type { CodexNativeHomeRecoveryRequest } from '../../shared/native-codex-home-recovery-contract'

const roots: string[] = []
const it = vitestIt.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(profile?: string) {
  const root = await mkdtemp(join(tmpdir(), 'native-home-removal-'))
  roots.push(root)
  const sourceHome = join(root, 'source')
  const storageRoot = join(root, 'storage')
  const homeDirectory = join(storageRoot, 'native', 'home')
  await mkdir(sourceHome, { mode: 0o700 })
  await mkdir(storageRoot, { mode: 0o700 })
  const context = { nativeVersion: '0.166.0' as const, ...(profile ? { profile } : {}) }
  const options = { sourceHome, storageRoot, homeDirectory, context, assertExclusive() {} }
  const file = profile ? `${profile}.config.toml` : 'config.toml'
  if (profile) {
    await writeFile(join(sourceHome, 'config.toml'), '# base config\n', { mode: 0o600 })
  }
  const sourcePath = join(sourceHome, file)
  const ownedPath = join(homeDirectory, file)
  const manifestPath = join(homeDirectory, '.opka-native-home.json')
  const manifest = async () =>
    CodexNativeHomeManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  const request = async (choices: CodexNativeHomeRecoveryRequest['choices']) => ({
    version: 1 as const,
    requestId: '00000000-0000-4000-8000-000000000002',
    file,
    expectedSourceHash: nativeHomeDigest(await readFile(sourcePath)),
    expectedOwnedHash: nativeHomeDigest(await readFile(ownedPath)),
    expectedManifestHash: nativeHomeDigest(await readFile(manifestPath)),
    choices,
    trustedProjects: []
  })
  const recover = (request: CodexNativeHomeRecoveryRequest) =>
    recoverCodexNativeHomeConfig({ ...options, request })
  return { root, options, sourcePath, ownedPath, manifestPath, file, manifest, request, recover }
}

it.each(['model', 'model_reasoning_effort', 'service_tier'] as const)(
  'removes only selected absent %s and preserves owned tables, hooks and history',
  async (key) => {
    const f = await fixture()
    await writeFile(f.sourcePath, `${key}="before"\n`, { mode: 0o600 })
    await prepareCodexNativeHome(f.options)
    const baseline = (await f.manifest()).configs[f.file]
    const suffix =
      '\n# owned settings\n[features]\nowned=true\n[projects."synthetic-project"]\ntrust_level="untrusted"\n'
    await appendFile(f.ownedPath, suffix)
    const hookPath = join(f.options.homeDirectory, 'hooks.json')
    const historyPath = join(f.options.homeDirectory, 'history.jsonl')
    await writeFile(hookPath, '{"synthetic":true}', { mode: 0o600 })
    await writeFile(historyPath, '{"session":"synthetic"}\n', { mode: 0o600 })
    await writeFile(f.sourcePath, '# source removed preference\n', { mode: 0o600 })
    const before = await readFile(f.ownedPath, 'utf8')
    await f.recover(await f.request({ [key]: 'source' }))
    expect(await readFile(f.ownedPath, 'utf8')).toBe(before.replace(`${key} = "before"\n`, ''))
    expect(parse(await readFile(f.ownedPath, 'utf8'))[key]).toBeUndefined()
    expect(await readFile(hookPath, 'utf8')).toBe('{"synthetic":true}')
    expect(await readFile(historyPath, 'utf8')).toBe('{"session":"synthetic"}\n')
    expect((await f.manifest()).configs[f.file]).toEqual({
      sourceHash: nativeHomeDigest(await readFile(f.sourcePath)),
      publishedHash: baseline?.publishedHash
    })
    await prepareCodexNativeHome(f.options)
    await writeFile(f.sourcePath, `${key}="later"\n`, { mode: 0o600 })
    await expect(prepareCodexNativeHome(f.options)).rejects.toMatchObject({
      code: 'native_cli_config_conflict'
    })
  }
)

it('treats an already absent source choice as a no-op and retains a selected owned override', async () => {
  const f = await fixture()
  await writeFile(f.sourcePath, 'service_tier="priority"\n', { mode: 0o600 })
  await prepareCodexNativeHome(f.options)
  await appendFile(f.ownedPath, '# owned override retained\n')
  await writeFile(f.sourcePath, '# removed tier\n', { mode: 0o600 })
  const before = await readFile(f.ownedPath)
  await f.recover(await f.request({ model: 'source', service_tier: 'owned' }))
  expect(await readFile(f.ownedPath)).toEqual(before)
  expect((await f.manifest()).configs[f.file]?.sourceHash).toBe(
    nativeHomeDigest(await readFile(f.sourcePath))
  )
})

it.each(['source', 'owned', 'manifest'] as const)(
  'refuses stale %s before source removal writes',
  async (changed) => {
    const f = await fixture()
    await writeFile(f.sourcePath, 'model="old"\n', { mode: 0o600 })
    await prepareCodexNativeHome(f.options)
    await writeFile(f.sourcePath, '# removed\n', { mode: 0o600 })
    const request = await f.request({ model: 'source' })
    const target =
      changed === 'source' ? f.sourcePath : changed === 'owned' ? f.ownedPath : f.manifestPath
    await appendFile(target, changed === 'manifest' ? ' ' : '# newer edit\n')
    const before = await Promise.all([readFile(f.ownedPath), readFile(f.manifestPath)])
    await expect(f.recover(request)).rejects.toMatchObject({ code: 'native_cli_config_conflict' })
    expect(await Promise.all([readFile(f.ownedPath), readFile(f.manifestPath)])).toEqual(before)
  }
)

it('removes a named profile preference without changing base config or owned profile features', async () => {
  const f = await fixture('night')
  await writeFile(f.sourcePath, 'model="profile-model"\n', { mode: 0o600 })
  await prepareCodexNativeHome(f.options)
  const basePath = join(f.options.homeDirectory, 'config.toml')
  const base = await readFile(basePath)
  await appendFile(f.ownedPath, '\n[features]\nprofile_only=true\n')
  await writeFile(f.sourcePath, '# removed profile model\n', { mode: 0o600 })
  await f.recover(await f.request({ model: 'source' }))
  expect(parse(await readFile(f.ownedPath, 'utf8'))).toMatchObject({
    features: { profile_only: true }
  })
  expect(parse(await readFile(f.ownedPath, 'utf8')).model).toBeUndefined()
  expect(await readFile(basePath)).toEqual(base)
})

it('removes a multiline owned preference and advances the published hash only for an exact source match', async () => {
  const f = await fixture()
  await writeFile(f.sourcePath, 'model="before"\n', { mode: 0o600 })
  await prepareCodexNativeHome(f.options)
  const original = await readFile(f.ownedPath, 'utf8')
  await writeFile(f.ownedPath, original.replace('model = "before"', 'model = """\nowned\n"""'))
  await writeFile(f.sourcePath, '', { mode: 0o600 })
  await f.recover(await f.request({ model: 'source' }))
  const repaired = await readFile(f.ownedPath)
  expect(parse(repaired.toString()).model).toBeUndefined()
  expect((await f.manifest()).configs[f.file]?.publishedHash).toBe(nativeHomeDigest(repaired))
  await writeFile(f.sourcePath, 'model="later"\n', { mode: 0o600 })
  await prepareCodexNativeHome(f.options)
  expect(parse(await readFile(f.ownedPath, 'utf8')).model).toBe('later')
})
