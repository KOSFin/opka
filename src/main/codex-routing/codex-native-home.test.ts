import {
  mkdir,
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  readdir,
  lstat,
  rm,
  symlink,
  appendFile
} from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it as vitestIt, vi } from 'vitest'
import { parse } from 'smol-toml'
import { prepareCodexNativeHome, readCodexNativeHomeSource } from './codex-native-home'
import { inspectNativeCodexGatewayAuth } from './native-codex-gateway-credential'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import { recoverCodexNativeHomeConfig } from './codex-native-home-recovery'
import { inspectCodexNativeHomeConfig } from './codex-native-home-inspection'
import { nativeHomeDigest } from './codex-native-home-inputs'
const it = vitestIt.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')
const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) {
    await rm(path, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opka-authless-home-')))
  directories.push(root)
  const sourceHome = join(root, 'original'),
    storageRoot = join(root, 'profile'),
    homeDirectory = join(storageRoot, 'routing', 'native', 'home')
  await mkdir(sourceHome, { mode: 0o700 })
  await mkdir(storageRoot, { mode: 0o700 })
  await writeFile(join(sourceHome, 'auth.json'), 'MUST NOT COPY', { mode: 0o600 })
  const options = {
    storageRoot,
    homeDirectory,
    sourceHome,
    assertExclusive: vi.fn(),
    context: { nativeVersion: '0.166.0' as const }
  }
  return { root, sourceHome, homeDirectory, options }
}
it('seeds one private authless HOME, preserving native config/tools and original bytes', async () => {
  const f = await fixture()
  const original =
    'model="chosen"\nmodel_catalog_json="catalog.json"\nsqlite_home="old-db"\nlog_dir="old-log"\n[mcp_servers.local]\ncommand="native-tool"\nargs=["--user-option"]\n'
  await writeFile(join(f.sourceHome, 'config.toml'), original, { mode: 0o600 })
  await mkdir(join(f.sourceHome, 'skills'))
  await writeFile(join(f.sourceHome, 'skills', 'known.md'), '# skill\n', { mode: 0o600 })
  const result = await prepareCodexNativeHome(f.options)
  expect(result.home).toBe(f.homeDirectory)
  expect(result.explicitCatalog?.path).toBe(join(f.sourceHome, 'catalog.json'))
  expect(await readFile(join(f.sourceHome, 'config.toml'), 'utf8')).toBe(original)
  expect(await readFile(join(f.sourceHome, 'auth.json'), 'utf8')).toBe('MUST NOT COPY')
  expect(await readdir(f.homeDirectory)).not.toContain('auth.json')
  const config = parse(await readFile(join(f.homeDirectory, 'config.toml'), 'utf8'))
  expect(config.model).toBe('chosen')
  expect(config.sqlite_home).toBe(join(f.homeDirectory, 'sqlite'))
  expect(config.log_dir).toBe(join(f.homeDirectory, 'log'))
  expect(config.mcp_servers).toEqual({ local: { command: 'native-tool', args: ['--user-option'] } })
  expect(await readFile(join(f.homeDirectory, 'skills', 'known.md'), 'utf8')).toBe('# skill\n')
  const originalStat = await lstat(join(f.sourceHome, 'skills', 'known.md')),
    ownedStat = await lstat(join(f.homeDirectory, 'skills', 'known.md'))
  expect(originalStat.ino).not.toBe(ownedStat.ino)
  expect(ownedStat.mode & 0o777).toBe(0o600)
})
it('uses separate0.166 profile files and preserves explicit CLI catalog precedence', async () => {
  const f = await fixture()
  await writeFile(
    join(f.sourceHome, 'config.toml'),
    'model="base"\nmodel_catalog_json="base.json"\n',
    { mode: 0o600 }
  )
  await writeFile(
    join(f.sourceHome, 'work.config.toml'),
    'model="profile"\nmodel_catalog_json="work.json"\n',
    { mode: 0o600 }
  )
  const first = await prepareCodexNativeHome({
    ...f.options,
    context: { ...f.options.context, profile: 'work' }
  })
  expect(first.explicitCatalog).toEqual({
    path: join(f.sourceHome, 'work.json'),
    origin: 'profile'
  })
  expect(parse(await readFile(join(f.homeDirectory, 'work.config.toml'), 'utf8')).model).toBe(
    'profile'
  )
  const cli = await prepareCodexNativeHome({
    ...f.options,
    context: { ...f.options.context, profile: 'work', cwd: f.root, catalogOverride: 'chosen.json' }
  })
  expect(cli.explicitCatalog).toEqual({ path: join(f.root, 'chosen.json'), origin: 'cli' })
})
it('retains native preference edits on repeats and refuses concurrent source edits', async () => {
  const f = await fixture()
  await writeFile(join(f.sourceHome, 'config.toml'), 'model="source"\n', { mode: 0o600 })
  await prepareCodexNativeHome(f.options)
  const path = join(f.homeDirectory, 'config.toml')
  await appendFile(path, '\n[features]\nuser_choice=true\n')
  const owned = await readFile(path, 'utf8'),
    before = await lstat(join(f.homeDirectory, '.opka-native-home.json'))
  for (let index = 0; index < 12; index++) {
    await prepareCodexNativeHome(f.options)
  }
  expect(await readFile(path, 'utf8')).toBe(owned)
  expect((await lstat(join(f.homeDirectory, '.opka-native-home.json'))).ino).toBe(before.ino)
  await writeFile(join(f.sourceHome, 'config.toml'), 'model="new-source"\n')
  await expect(prepareCodexNativeHome(f.options)).rejects.toMatchObject({
    code: 'native_cli_config_conflict'
  })
  expect(await readFile(path, 'utf8')).toBe(owned)
})
it('copies a selected old rollout once without sharing inode or changing original history', async () => {
  const f = await fixture(),
    threadId = '10000000-0000-4000-8000-000000000001'
  const directory = join(f.sourceHome, 'sessions', '2026', '11', '05')
  await mkdir(directory, { recursive: true })
  const transcriptPath = join(directory, `rollout-2026-11-05T00-00-00-${threadId}.jsonl`)
  const original = `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`
  await writeFile(transcriptPath, original, { mode: 0o600 })
  const options = { ...f.options, adopt: { sourceHome: f.sourceHome, transcriptPath } }
  const first = await prepareCodexNativeHome(options)
  if (!first.adopted) {
    throw new Error('Missing adoption')
  }
  const owned = first.adopted.transcriptPath,
    before = await lstat(owned)
  expect(before.ino).not.toBe((await lstat(transcriptPath)).ino)
  await appendFile(owned, '{"type":"event_msg","payload":{"type":"task_complete"}}\n')
  for (let index = 0; index < 12; index++) {
    await prepareCodexNativeHome(options)
  }
  expect((await lstat(owned)).ino).toBe(before.ino)
  expect(await readFile(transcriptPath, 'utf8')).toBe(original)
  expect(await readFile(owned, 'utf8')).toContain('task_complete')
  expect(await readdir(join(f.homeDirectory, 'sessions', '2026', '11', '05'))).toEqual([
    basename(transcriptPath)
  ])
  expect(await readdir(f.homeDirectory)).not.toContain('.opka-native-home-pending.json')
})
it('refuses unknown existing homes, symlinked tool resources and legacy profile selectors', async () => {
  const f = await fixture()
  await mkdir(f.homeDirectory, { recursive: true })
  await writeFile(join(f.homeDirectory, 'unknown'), 'keep')
  await expect(prepareCodexNativeHome(f.options)).rejects.toThrow('unowned')
  expect(await readFile(join(f.homeDirectory, 'unknown'), 'utf8')).toBe('keep')
  await rm(f.homeDirectory, { recursive: true })
  await symlink(join(f.sourceHome, 'auth.json'), join(f.sourceHome, 'skills'))
  await expect(prepareCodexNativeHome(f.options)).rejects.toThrow('ownership')
  await rm(join(f.sourceHome, 'skills'))
  await writeFile(join(f.sourceHome, 'config.toml'), 'profile="work"\n', { mode: 0o600 })
  await expect(prepareCodexNativeHome(f.options)).rejects.toThrow('separate named profile')
})
it('preserves and refuses interrupted owned preparation instead of discarding state', async () => {
  const f = await fixture()
  await prepareCodexNativeHome(f.options)
  await writeFile(join(f.homeDirectory, '.opka-native-home-pending.json'), '{}', { mode: 0o600 })
  await expect(prepareCodexNativeHome(f.options)).rejects.toMatchObject({
    code: 'native_cli_home_preparation_pending'
  })
  expect(await readFile(join(f.homeDirectory, '.opka-native-home-pending.json'), 'utf8')).toBe('{}')
})

it('refuses a foreign routing login before creating a pending marker or changing config', async () => {
  const f = await fixture()
  await writeFile(join(f.sourceHome, 'config.toml'), 'model="source"\n', { mode: 0o600 })
  await prepareCodexNativeHome(f.options)
  const authPath = join(f.homeDirectory, 'auth.json')
  const foreign = '{"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-foreign"}'
  await writeFile(authPath, foreign, { mode: 0o600 })
  await writeFile(join(f.sourceHome, 'config.toml'), 'model="changed"\n', { mode: 0o600 })
  const configPath = join(f.homeDirectory, 'config.toml')
  const before = await readFile(configPath, 'utf8')
  const options = {
    ...f.options,
    inspectGatewayAuth: (home: string) =>
      inspectNativeCodexGatewayAuth(home, 'a'.repeat(64), f.options.assertExclusive)
  }
  await expect(prepareCodexNativeHome(options)).rejects.toBeInstanceOf(NativeCliControlError)
  await expect(prepareCodexNativeHome(options)).rejects.toMatchObject({
    code: 'native_cli_routing_auth_conflict'
  })
  expect(await readFile(authPath, 'utf8')).toBe(foreign)
  expect(await readFile(configPath, 'utf8')).toBe(before)
  expect(await readdir(f.homeDirectory)).not.toContain('.opka-native-home-pending.json')
})

it('identifies a foreign login in a first-launch authless HOME before ownership metadata exists', async () => {
  const f = await fixture()
  await mkdir(f.homeDirectory, { recursive: true, mode: 0o700 })
  const authPath = join(f.homeDirectory, 'auth.json')
  const foreign = '{"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-foreign"}'
  await writeFile(authPath, foreign, { mode: 0o600 })
  const options = {
    ...f.options,
    inspectGatewayAuth: (home: string) =>
      inspectNativeCodexGatewayAuth(home, 'a'.repeat(64), f.options.assertExclusive)
  }
  await expect(prepareCodexNativeHome(options)).rejects.toMatchObject({
    code: 'native_cli_routing_auth_conflict'
  })
  expect(await readFile(authPath, 'utf8')).toBe(foreign)
  expect(await readdir(f.homeDirectory)).not.toContain('.opka-native-home-pending.json')
  expect(await readdir(f.homeDirectory)).not.toContain('.opka-native-home.json')
})

it('applies explicit preference choices and proven trust without losing owned edits or future conflict detection', async () => {
  const f = await fixture()
  const project = join(f.root, 'trusted-project')
  await mkdir(project)
  const firstSource = 'model="first"\nmodel_reasoning_effort="medium"\nservice_tier="priority"\n'
  await writeFile(join(f.sourceHome, 'config.toml'), firstSource, { mode: 0o600 })
  await prepareCodexNativeHome(f.options)
  const ownedPath = join(f.homeDirectory, 'config.toml')
  await appendFile(ownedPath, '\n[features]\nowned_feature=true\n')
  const changedSource = `model="source"\nmodel_reasoning_effort="high"\nservice_tier="flex"\n[projects."${project}"]\ntrust_level="trusted"\n`
  await writeFile(join(f.sourceHome, 'config.toml'), changedSource, { mode: 0o600 })
  const manifestPath = join(f.homeDirectory, '.opka-native-home.json')
  const manifest = await readFile(manifestPath)
  const owned = await readFile(ownedPath)
  const request = {
    version: 1 as const,
    requestId: '00000000-0000-4000-8000-000000000001',
    file: 'config.toml',
    expectedManifestHash: nativeHomeDigest(manifest),
    expectedSourceHash: nativeHomeDigest(changedSource),
    expectedOwnedHash: nativeHomeDigest(owned),
    choices: {
      model: 'owned' as const,
      model_reasoning_effort: 'source' as const,
      service_tier: 'source' as const
    },
    trustedProjects: [project]
  }
  const preview = await inspectCodexNativeHomeConfig({
    storageRoot: f.options.storageRoot,
    homeDirectory: f.homeDirectory,
    context: f.options.context,
    assertExclusive: f.options.assertExclusive
  })
  expect(preview).toMatchObject({
    state: 'prepared',
    manifestHash: request.expectedManifestHash,
    files: [{ file: 'config.toml', eligibleTrustedProjects: [project] }]
  })
  await recoverCodexNativeHomeConfig({
    storageRoot: f.options.storageRoot,
    homeDirectory: f.homeDirectory,
    context: f.options.context,
    request,
    assertExclusive: f.options.assertExclusive
  })
  const repaired = parse(await readFile(ownedPath, 'utf8'))
  expect(repaired.model).toBe('first')
  expect(repaired.model_reasoning_effort).toBe('high')
  expect(repaired.service_tier).toBe('flex')
  expect(repaired.features).toEqual({ owned_feature: true })
  expect(repaired.projects).toEqual({ [project]: { trust_level: 'trusted' } })
  expect(await readdir(f.homeDirectory)).not.toContain('.opka-native-home-pending.json')
  await writeFile(join(f.sourceHome, 'config.toml'), changedSource.replace('source', 'later'))
  await expect(prepareCodexNativeHome(f.options)).rejects.toMatchObject({
    code: 'native_cli_config_conflict'
  })
})

it('refuses stale recovery and an owned untrusted project without writing either file', async () => {
  const f = await fixture()
  const project = join(f.root, 'denied-project')
  await mkdir(project)
  await writeFile(join(f.sourceHome, 'config.toml'), 'model="first"\n', { mode: 0o600 })
  await prepareCodexNativeHome(f.options)
  const ownedPath = join(f.homeDirectory, 'config.toml')
  await appendFile(ownedPath, `[projects."${project}"]\ntrust_level="untrusted"\n`)
  const source = `model="second"\n[projects."${project}"]\ntrust_level="trusted"\n`
  await writeFile(join(f.sourceHome, 'config.toml'), source, { mode: 0o600 })
  const manifestPath = join(f.homeDirectory, '.opka-native-home.json')
  const manifest = await readFile(manifestPath)
  const owned = await readFile(ownedPath)
  const request = {
    version: 1 as const,
    requestId: '00000000-0000-4000-8000-000000000002',
    file: 'config.toml',
    expectedManifestHash: nativeHomeDigest(manifest),
    expectedSourceHash: nativeHomeDigest(source),
    expectedOwnedHash: nativeHomeDigest(owned),
    choices: { model: 'source' as const },
    trustedProjects: [project]
  }
  const recover = () =>
    recoverCodexNativeHomeConfig({
      storageRoot: f.options.storageRoot,
      homeDirectory: f.homeDirectory,
      context: f.options.context,
      request,
      assertExclusive: f.options.assertExclusive
    })
  await expect(recover()).rejects.toMatchObject({ code: 'native_cli_trust_proof_missing' })
  expect(await readFile(ownedPath)).toEqual(owned)
  expect(await readFile(manifestPath)).toEqual(manifest)
  await appendFile(ownedPath, '# later edit\n')
  await expect(recover()).rejects.toMatchObject({ code: 'native_cli_config_conflict' })
  expect(await readdir(f.homeDirectory)).not.toContain('.opka-native-home-pending.json')
})

it('refreshes a source config only while its owned publication is unchanged', async () => {
  const f = await fixture()
  await writeFile(join(f.sourceHome, 'config.toml'), 'model="before"\n', { mode: 0o600 })
  await prepareCodexNativeHome(f.options)
  await writeFile(join(f.sourceHome, 'config.toml'), 'model="after"\n')
  await prepareCodexNativeHome(f.options)
  expect(parse(await readFile(join(f.homeDirectory, 'config.toml'), 'utf8')).model).toBe('after')
  await rm(join(f.homeDirectory, 'config.toml'))
  await expect(prepareCodexNativeHome(f.options)).rejects.toThrow('preferences are unavailable')
})

it('keeps the first preference source across account-default changes and exposes its durable dependency', async () => {
  const f = await fixture()
  await writeFile(join(f.sourceHome, 'config.toml'), 'model="original-preference"\n', {
    mode: 0o600
  })
  await prepareCodexNativeHome(f.options)
  const another = join(f.root, 'another-account')
  await mkdir(another)
  await writeFile(join(another, 'config.toml'), 'model="another-account"\n', { mode: 0o600 })
  const before = await lstat(join(f.homeDirectory, '.opka-native-home.json'))
  const result = await prepareCodexNativeHome({ ...f.options, sourceHome: another })
  expect(result.sourceHome).toBe(f.sourceHome)
  expect(parse(await readFile(join(f.homeDirectory, 'config.toml'), 'utf8')).model).toBe(
    'original-preference'
  )
  expect((await lstat(join(f.homeDirectory, '.opka-native-home.json'))).ino).toBe(before.ino)
  expect(await readCodexNativeHomeSource(f.options)).toBe(f.sourceHome)
})
it('seeds user hooks and installed artifacts once while plugin operational state starts fresh', async () => {
  const f = await fixture()
  await mkdir(join(f.sourceHome, 'plugins', 'cache'), { recursive: true })
  await mkdir(join(f.sourceHome, 'plugins', 'data'))
  await mkdir(join(f.sourceHome, 'plugin-state'))
  await writeFile(
    join(f.sourceHome, 'plugins', 'cache', 'artifact'),
    Buffer.alloc(2 * 1024 * 1024, 7),
    { mode: 0o700 }
  )
  await writeFile(join(f.sourceHome, 'plugins', 'installed.json'), '{"installed":true}', {
    mode: 0o600
  })
  await writeFile(join(f.sourceHome, 'plugins', 'data', 'private-state'), 'not migrated', {
    mode: 0o600
  })
  await writeFile(join(f.sourceHome, 'plugin-state', 'private-state'), 'not migrated', {
    mode: 0o600
  })
  const hooks = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-hook"}]}]}}'
  await writeFile(join(f.sourceHome, 'hooks.json'), hooks, { mode: 0o600 })
  await prepareCodexNativeHome(f.options)
  expect(await readFile(join(f.homeDirectory, 'hooks.json'), 'utf8')).toBe(hooks)
  expect((await lstat(join(f.homeDirectory, 'plugins', 'cache', 'artifact'))).size).toBe(
    2 * 1024 * 1024
  )
  expect(await readdir(join(f.homeDirectory, 'plugins', 'data'))).toEqual([])
  expect(await readdir(join(f.homeDirectory, 'plugin-state'))).toEqual([])
  await writeFile(join(f.homeDirectory, 'plugins', 'data', 'owned-state'), 'native owned', {
    mode: 0o600
  })
  await rm(join(f.sourceHome, 'plugins'), { recursive: true })
  await prepareCodexNativeHome(f.options)
  expect(await readFile(join(f.homeDirectory, 'plugins', 'data', 'owned-state'), 'utf8')).toBe(
    'native owned'
  )
  expect(await readFile(join(f.sourceHome, 'plugin-state', 'private-state'), 'utf8')).toBe(
    'not migrated'
  )
})
it('materializes an approved global skill link without a writable link to the original', async () => {
  const f = await fixture(),
    globalSkills = join(f.root, 'global-skills')
  await mkdir(globalSkills)
  await writeFile(join(globalSkills, 'known.md'), '# shared skill', { mode: 0o600 })
  await mkdir(join(f.sourceHome, 'skills'))
  await symlink(globalSkills, join(f.sourceHome, 'skills', 'shared'))
  await prepareCodexNativeHome({ ...f.options, resourceRoots: [globalSkills] })
  const target = join(f.homeDirectory, 'skills', 'shared', 'known.md')
  expect(await readFile(target, 'utf8')).toBe('# shared skill')
  expect((await lstat(join(f.homeDirectory, 'skills', 'shared'))).isSymbolicLink()).toBe(false)
  expect((await lstat(target)).ino).not.toBe((await lstat(join(globalSkills, 'known.md'))).ino)
  await writeFile(target, 'owned edit')
  expect(await readFile(join(globalSkills, 'known.md'), 'utf8')).toBe('# shared skill')
})

it('accepts an aliased storage root without following symlinked target descendants', async () => {
  const f = await fixture(),
    alias = join(f.root, 'profile-alias')
  await symlink(f.options.storageRoot, alias)
  const options = {
    ...f.options,
    storageRoot: alias,
    homeDirectory: join(alias, 'routing', 'native', 'home')
  }
  const result = await prepareCodexNativeHome(options)
  expect(result.home).toBe(f.homeDirectory)
  expect(await readCodexNativeHomeSource(options)).toBe(f.sourceHome)
  const escaped = join(f.root, 'escaped')
  await mkdir(escaped)
  await symlink(escaped, join(f.options.storageRoot, 'other-target'))
  await expect(
    prepareCodexNativeHome({
      ...f.options,
      homeDirectory: join(f.options.storageRoot, 'other-target', 'home')
    })
  ).rejects.toThrow('symlinks')
})
