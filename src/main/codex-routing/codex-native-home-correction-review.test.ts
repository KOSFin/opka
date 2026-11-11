import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { prepareCodexNativeHome } from './codex-native-home'
import { recoverCodexNativeHomeConfig } from './codex-native-home-recovery'
import { nativeHomeDigest } from './codex-native-home-inputs'
import { inspectNativeCodexGatewayAuth } from './native-codex-gateway-credential'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'removes an absent source key with a multiline owned value without broadening trust',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-home-correction-review-'))
    roots.push(root)
    const sourceHome = join(root, 'source')
    const storageRoot = join(root, 'storage')
    const homeDirectory = join(storageRoot, 'native', 'home')
    await mkdir(sourceHome, { mode: 0o700 })
    await mkdir(storageRoot, { mode: 0o700 })
    const sourcePath = join(sourceHome, 'config.toml')
    const ownedPath = join(homeDirectory, 'config.toml')
    const manifestPath = join(homeDirectory, '.opka-native-home.json')
    const options = {
      sourceHome,
      storageRoot,
      homeDirectory,
      context: { nativeVersion: '0.166.0' as const },
      assertExclusive: () => undefined
    }
    await writeFile(sourcePath, 'model="old"\nservice_tier="priority"\n', { mode: 0o600 })
    await prepareCodexNativeHome(options)
    const oldManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const owned = [
      'model = """owned',
      '[decoy]',
      'model = "inside-value"',
      '"""',
      'service_tier = "priority"',
      '[features]',
      'owned = true',
      '[projects."/synthetic-untrusted"]',
      'trust_level = "untrusted"',
      ''
    ].join('\n')
    await writeFile(ownedPath, owned, { mode: 0o600 })
    const source = 'service_tier="flex"\n'
    await writeFile(sourcePath, source, { mode: 0o600 })
    await recoverCodexNativeHomeConfig({
      storageRoot,
      homeDirectory,
      context: options.context,
      assertExclusive: options.assertExclusive,
      request: {
        version: 1,
        requestId: '00000000-0000-4000-8000-000000000003',
        file: 'config.toml',
        expectedManifestHash: nativeHomeDigest(await readFile(manifestPath)),
        expectedSourceHash: nativeHomeDigest(source),
        expectedOwnedHash: nativeHomeDigest(owned),
        choices: { model: 'source', service_tier: 'source' },
        trustedProjects: []
      }
    })
    const result = parse(await readFile(ownedPath, 'utf8'))
    expect(result.model).toBeUndefined()
    expect(result.service_tier).toBe('flex')
    expect(result.features).toEqual({ owned: true })
    expect(result.projects).toEqual({ '/synthetic-untrusted': { trust_level: 'untrusted' } })
    const newManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(newManifest.configs['config.toml'].publishedHash).toBe(
      oldManifest.configs['config.toml'].publishedHash
    )
    await prepareCodexNativeHome(options)
    await writeFile(sourcePath, 'model="later"\nservice_tier="flex"\n', { mode: 0o600 })
    await expect(prepareCodexNativeHome(options)).rejects.toMatchObject({
      code: 'native_cli_config_conflict'
    })
  }
)

it
  .skipIf(process.platform !== 'linux' && process.platform !== 'darwin')
  .each(['first', 'existing'] as const)(
  'refuses synthetic foreign auth before admitting an %s HOME update',
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), 'native-home-foreign-review-'))
    roots.push(root)
    const sourceHome = join(root, 'source')
    const storageRoot = join(root, 'storage')
    const homeDirectory = join(storageRoot, 'native', 'home')
    await mkdir(sourceHome, { mode: 0o700 })
    await mkdir(storageRoot, { mode: 0o700 })
    await writeFile(join(sourceHome, 'config.toml'), 'model="before"\n', { mode: 0o600 })
    const options = {
      sourceHome,
      storageRoot,
      homeDirectory,
      context: { nativeVersion: '0.166.0' as const },
      assertExclusive: () => undefined
    }
    if (stage === 'existing') {
      await prepareCodexNativeHome(options)
      await writeFile(join(sourceHome, 'config.toml'), 'model="changed"\n', { mode: 0o600 })
    } else {
      await mkdir(homeDirectory, { recursive: true, mode: 0o700 })
    }
    const ownedPath = join(homeDirectory, 'config.toml')
    const before = stage === 'existing' ? await readFile(ownedPath) : null
    const foreign = '{"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-foreign"}'
    await writeFile(join(homeDirectory, 'auth.json'), foreign, { mode: 0o600 })
    await expect(
      prepareCodexNativeHome({
        ...options,
        inspectGatewayAuth: (home) =>
          inspectNativeCodexGatewayAuth(home, 'a'.repeat(64), options.assertExclusive)
      })
    ).rejects.toMatchObject({ code: 'native_cli_routing_auth_conflict' })
    expect(await readFile(join(homeDirectory, 'auth.json'), 'utf8')).toBe(foreign)
    expect(await readdir(homeDirectory)).not.toContain('.opka-native-home-pending.json')
    if (before) {
      expect(await readFile(ownedPath)).toEqual(before)
    } else {
      expect(await readdir(homeDirectory)).not.toContain('.opka-native-home.json')
    }
  }
)
