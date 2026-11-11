import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'smol-toml'
import { prepareCodexNativeHome } from './codex-native-home'
import { recoverCodexNativeHomeConfig } from './codex-native-home-recovery'
import { nativeHomeDigest } from './codex-native-home-inputs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'uses an absent source preference when explicitly selected after both homes changed',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-home-review-'))
    roots.push(root)
    const sourceHome = join(root, 'source')
    const storageRoot = join(root, 'storage')
    const homeDirectory = join(storageRoot, 'native', 'home')
    await mkdir(sourceHome, { mode: 0o700 })
    await mkdir(storageRoot, { mode: 0o700 })
    await writeFile(join(sourceHome, 'config.toml'), 'model="old"\nservice_tier="priority"\n', {
      mode: 0o600
    })
    const options = {
      sourceHome,
      storageRoot,
      homeDirectory,
      context: { nativeVersion: '0.166.0' as const },
      assertExclusive: () => undefined
    }
    await prepareCodexNativeHome(options)
    const ownedPath = join(homeDirectory, 'config.toml')
    await appendFile(ownedPath, '\n[features]\nowned=true\n')
    const nextSource = 'service_tier="flex"\n'
    await writeFile(join(sourceHome, 'config.toml'), nextSource, { mode: 0o600 })
    const manifest = await readFile(join(homeDirectory, '.opka-native-home.json'))
    const owned = await readFile(ownedPath)
    await recoverCodexNativeHomeConfig({
      storageRoot,
      homeDirectory,
      context: options.context,
      assertExclusive: options.assertExclusive,
      request: {
        version: 1,
        requestId: '00000000-0000-4000-8000-000000000001',
        file: 'config.toml',
        expectedManifestHash: nativeHomeDigest(manifest),
        expectedSourceHash: nativeHomeDigest(nextSource),
        expectedOwnedHash: nativeHomeDigest(owned),
        choices: { model: 'source', service_tier: 'source' },
        trustedProjects: []
      }
    })
    const repaired = parse(await readFile(ownedPath, 'utf8'))
    expect(repaired.model).toBeUndefined()
    expect(repaired.service_tier).toBe('flex')
    expect(repaired.features).toEqual({ owned: true })
  }
)
