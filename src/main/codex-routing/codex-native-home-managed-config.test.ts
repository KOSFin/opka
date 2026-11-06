import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { afterEach, expect, it as vitestIt } from 'vitest'
import { prepareCodexNativeHome } from './codex-native-home'
import { computeTrustKey } from '../codex/config-toml-trust'
import { nativeHomeDigest } from './codex-native-home-inputs'
const it = vitestIt.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opka-managed-native-config-')))
  roots.push(root)
  const sourceHome = join(root, 'source'),
    storageRoot = join(root, 'storage')
  await mkdir(sourceHome, { mode: 0o700 })
  await mkdir(storageRoot, { mode: 0o700 })
  await writeFile(join(sourceHome, 'config.toml'), 'model="before"\n', { mode: 0o600 })
  const options = {
    sourceHome,
    storageRoot,
    homeDirectory: join(storageRoot, 'native'),
    context: { nativeVersion: '0.166.0' as const },
    assertExclusive: () => {}
  }
  const prepareManagedConfig = async (home: string) => {
    const path = join(home, 'config.toml'),
      config = parse(await readFile(path, 'utf8'))
    const key = computeTrustKey({
      sourcePath: join(home, 'hooks.json'),
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'fixture'
    })
    config.hooks = { state: { [key]: { enabled: true, trusted_hash: 'verified-hash' } } }
    await writeFile(path, stringify(config), { mode: 0o600 })
    return new Set([key])
  }
  return {
    options,
    source: join(sourceHome, 'config.toml'),
    owned: join(options.homeDirectory, 'config.toml'),
    prepareManagedConfig
  }
}
it('records a managed trust mutation before publishing the owned baseline', async () => {
  const f = await fixture()
  await prepareCodexNativeHome({ ...f.options, prepareManagedConfig: f.prepareManagedConfig })
  expect(parse(await readFile(f.owned, 'utf8')).hooks).toBeDefined()
  const manifest = JSON.parse(
    await readFile(join(f.options.homeDirectory, '.opka-native-home.json'), 'utf8')
  )
  expect(manifest.configs['config.toml'].publishedHash).toBe(
    nativeHomeDigest(await readFile(f.owned))
  )
  await writeFile(f.source, 'model="after"\n')
  await prepareCodexNativeHome({ ...f.options, prepareManagedConfig: f.prepareManagedConfig })
  expect(parse(await readFile(f.owned, 'utf8')).model).toBe('after')
})
it('preserves a genuine owned user edit when the source also changes', async () => {
  const f = await fixture()
  await prepareCodexNativeHome({ ...f.options, prepareManagedConfig: f.prepareManagedConfig })
  await writeFile(f.owned, `${await readFile(f.owned, 'utf8')}\nuser_preference=true\n`)
  const before = await readFile(f.owned, 'utf8')
  await writeFile(f.source, 'model="after"\n')
  await expect(
    prepareCodexNativeHome({ ...f.options, prepareManagedConfig: f.prepareManagedConfig })
  ).rejects.toThrow('changed in both homes')
  expect(await readFile(f.owned, 'utf8')).toBe(before)
})
it('does not bless a user change arriving while the managed installer awaits', async () => {
  const f = await fixture()
  await prepareCodexNativeHome({
    ...f.options,
    prepareManagedConfig: async (home) => {
      const keys = await f.prepareManagedConfig(home)
      await writeFile(f.owned, `${await readFile(f.owned, 'utf8')}\nuser_preference=true\n`)
      return keys
    }
  })
  await writeFile(f.source, 'model="after"\n')
  await expect(prepareCodexNativeHome(f.options)).rejects.toThrow('changed in both homes')
})
it('leaves the existing interrupted-preparation guard if a managed installer fails', async () => {
  const f = await fixture()
  await expect(
    prepareCodexNativeHome({
      ...f.options,
      prepareManagedConfig: async () => {
        throw new Error('installer failed')
      }
    })
  ).rejects.toThrow('installer failed')
  await expect(prepareCodexNativeHome(f.options)).rejects.toThrow('Interrupted native')
})

it('does not bless concurrent user comments outside the managed trust entry', async () => {
  const f = await fixture()
  await prepareCodexNativeHome({
    ...f.options,
    prepareManagedConfig: async (home) => {
      const keys = await f.prepareManagedConfig(home)
      await writeFile(f.owned, `# user comment\n${await readFile(f.owned, 'utf8')}`)
      return keys
    }
  })
  await writeFile(f.source, 'model="after"\n')
  await expect(prepareCodexNativeHome(f.options)).rejects.toThrow('changed in both homes')
})
