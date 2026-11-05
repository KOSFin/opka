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
  await expect(prepareCodexNativeHome(f.options)).rejects.toThrow('both homes')
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
  await expect(prepareCodexNativeHome(f.options)).rejects.toThrow('Interrupted')
  expect(await readFile(join(f.homeDirectory, '.opka-native-home-pending.json'), 'utf8')).toBe('{}')
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
