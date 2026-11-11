import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parse } from 'smol-toml'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import {
  nativeUserDirectory,
  nativeUserFile,
  nativeUserInside
} from '../cli/native-cli-user-installation-files'
import { CodexNativeHomeManifestSchema } from './codex-native-home-manifest'
import { readNativeHomeConfigs, type CodexNativeHomeContext } from './codex-native-home-config'
import { nativeHomeProjectTrustEntries } from './codex-native-home-project-trust'

/** Values and exact hashes for a host-local choice; no TOML or credential bytes leave the host. */
export async function inspectCodexNativeHomeConfig(options: {
  storageRoot: string
  homeDirectory: string
  context: CodexNativeHomeContext
  assertExclusive: () => void
}) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new NativeCliControlError('unsupported')
  }
  const root = await realpath(resolve(options.storageRoot))
  const lexicalRoot = resolve(options.storageRoot)
  const lexicalHome = resolve(options.homeDirectory)
  if (!nativeUserInside(lexicalRoot, lexicalHome)) {
    throw new NativeCliControlError('config_conflict')
  }
  const home = join(root, relative(lexicalRoot, lexicalHome))
  options.assertExclusive()
  try {
    await nativeUserDirectory(root, home, false)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { version: 1 as const, state: 'not_prepared' as const }
    }
    throw error
  }
  if (await nativeUserFile(join(home, '.opka-native-home-pending.json'))) {
    throw new NativeCliControlError('home_preparation_pending')
  }
  const manifestFile = await nativeUserFile(join(home, '.opka-native-home.json'))
  if (!manifestFile) {
    return { version: 1 as const, state: 'not_prepared' as const }
  }
  const manifest = CodexNativeHomeManifestSchema.parse(JSON.parse(manifestFile.bytes.toString()))
  if ((await realpath(manifest.sourceHome)) !== manifest.sourceHome) {
    throw new NativeCliControlError('config_conflict')
  }
  const configs = await readNativeHomeConfigs(manifest.sourceHome, home, options.context)
  const files: Record<string, unknown>[] = []
  for (const source of configs.files) {
    const owned = await nativeUserFile(join(home, source.name))
    if (!source.sourceHash || !owned) {
      throw new NativeCliControlError('config_conflict')
    }
    const sourceValues = parse(source.contents)
    const ownedValues = parse(owned.bytes.toString())
    const values = Object.fromEntries(
      ['model', 'model_reasoning_effort', 'service_tier'].map((key) => [
        key,
        {
          source: typeof sourceValues[key] === 'string' ? sourceValues[key] : null,
          owned: typeof ownedValues[key] === 'string' ? ownedValues[key] : null
        }
      ])
    )
    const eligibleTrustedProjects: string[] = []
    if (source.name === 'config.toml') {
      const fromSource = nativeHomeProjectTrustEntries(sourceValues.projects)
      const fromOwned = nativeHomeProjectTrustEntries(ownedValues.projects)
      for (const entry of fromSource) {
        if (
          entry.level !== 'trusted' ||
          fromSource.filter((candidate) => candidate.normalized === entry.normalized).length !==
            1 ||
          fromOwned.some((candidate) => candidate.normalized === entry.normalized) ||
          !isAbsolute(entry.path) ||
          (await realpath(entry.path).catch(() => null)) !== entry.path
        ) {
          continue
        }
        const info = await lstat(entry.path).catch(() => null)
        if (info?.isDirectory() && !info.isSymbolicLink()) {
          eligibleTrustedProjects.push(entry.path)
        }
      }
    }
    files.push({
      file: source.name,
      sourceHash: source.sourceHash,
      ownedHash: owned.sha256,
      baseline: manifest.configs[source.name] ?? null,
      values,
      eligibleTrustedProjects,
      requestTemplate: {
        version: 1 as const,
        requestId: randomUUID(),
        file: source.name,
        expectedManifestHash: manifestFile.sha256,
        expectedSourceHash: source.sourceHash,
        expectedOwnedHash: owned.sha256,
        choices: {},
        trustedProjects: []
      }
    })
  }
  options.assertExclusive()
  return {
    version: 1 as const,
    state: 'prepared' as const,
    manifestHash: manifestFile.sha256,
    files
  }
}
