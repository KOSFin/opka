import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parse } from 'smol-toml'
import { upsertTopLevelSettingsInContent } from '../codex/codex-config-settings-upsert'
import { removePromotedSettingsFromContent } from '../codex/codex-config-settings-removal'
import { upsertProjectTrustContent } from '../codex/config-toml-project-trust'
import { normalizeCodexTrustProjectPath } from '../codex/codex-trust-identity'
import { nativeHomeProjectTrustEntries } from './codex-native-home-project-trust'
import {
  nativeUserDirectory,
  nativeUserFile,
  nativeUserInside,
  replaceNativeUserFile,
  writeNativeUserPrivate
} from '../cli/native-cli-user-installation-files'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import {
  CodexNativeHomeRecoveryRequestSchema,
  type CodexNativeHomeRecoveryRequest
} from '../../shared/native-codex-home-recovery-contract'
import { CodexNativeHomeManifestSchema } from './codex-native-home-manifest'
import { readNativeHomeConfigs, type CodexNativeHomeContext } from './codex-native-home-config'
import { nativeHomeDigest } from './codex-native-home-inputs'

/** The caller holds the profile lease; every decision is checked again before the first write. */
export async function recoverCodexNativeHomeConfig(options: {
  storageRoot: string
  homeDirectory: string
  context: CodexNativeHomeContext
  request: CodexNativeHomeRecoveryRequest
  assertExclusive: () => void
}): Promise<void> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new NativeCliControlError('unsupported')
  }
  const request = CodexNativeHomeRecoveryRequestSchema.parse(options.request)
  if (Object.keys(request.choices).length === 0 && request.trustedProjects.length === 0) {
    throw new NativeCliControlError('config_conflict')
  }
  const lexicalRoot = resolve(options.storageRoot)
  const lexicalHome = resolve(options.homeDirectory)
  if (!nativeUserInside(lexicalRoot, lexicalHome)) {
    throw new NativeCliControlError('config_conflict')
  }
  const storageRoot = await realpath(lexicalRoot)
  const home = join(storageRoot, relative(lexicalRoot, lexicalHome))
  const markerPath = join(home, '.opka-native-home-pending.json')
  options.assertExclusive()
  await nativeUserDirectory(storageRoot, home, false)
  if (await nativeUserFile(markerPath)) {
    throw new NativeCliControlError('home_preparation_pending')
  }
  const manifestPath = join(home, '.opka-native-home.json')
  const manifestFile = await nativeUserFile(manifestPath)
  if (!manifestFile || manifestFile.sha256 !== request.expectedManifestHash) {
    throw new NativeCliControlError('config_conflict')
  }
  const manifest = CodexNativeHomeManifestSchema.parse(JSON.parse(manifestFile.bytes.toString()))
  if ((await realpath(manifest.sourceHome)) !== manifest.sourceHome) {
    throw new NativeCliControlError('config_conflict')
  }
  const sourceDirectory = await lstat(manifest.sourceHome)
  if (
    !sourceDirectory.isDirectory() ||
    sourceDirectory.isSymbolicLink() ||
    sourceDirectory.uid !== process.getuid?.() ||
    (sourceDirectory.mode & 0o022) !== 0
  ) {
    throw new NativeCliControlError('config_conflict')
  }
  const prepared = await readNativeHomeConfigs(manifest.sourceHome, home, options.context)
  const source = prepared.files.find((file) => file.name === request.file)
  const ownedPath = join(home, request.file)
  const owned = await nativeUserFile(ownedPath)
  if (
    !source ||
    !source.sourceHash ||
    source.sourceHash !== request.expectedSourceHash ||
    !owned ||
    owned.sha256 !== request.expectedOwnedHash ||
    !manifest.configs[request.file]
  ) {
    throw new NativeCliControlError('config_conflict')
  }
  const sourceConfig = parse(source.contents)
  const ownedContent = owned.bytes.toString('utf8')
  const ownedConfig = parse(ownedContent)
  for (const key of ['model', 'model_reasoning_effort', 'service_tier'] as const) {
    if (sourceConfig[key] !== ownedConfig[key] && !request.choices[key]) {
      throw new NativeCliControlError('config_conflict')
    }
  }
  const updates = new Map<string, string>()
  const removals = new Set<string>()
  for (const [key, choice] of Object.entries(request.choices)) {
    if (choice === 'source') {
      const value = sourceConfig[key]
      if (value === undefined) {
        removals.add(key)
        continue
      }
      if (typeof value !== 'string') {
        throw new NativeCliControlError('config_conflict')
      }
      updates.set(key, JSON.stringify(value))
    }
  }
  let repaired = upsertTopLevelSettingsInContent(
    removePromotedSettingsFromContent(ownedContent, removals),
    updates
  )
  if (request.trustedProjects.length) {
    if (request.file !== 'config.toml') {
      throw new NativeCliControlError('trust_proof_missing')
    }
    const sourceProjects = nativeHomeProjectTrustEntries(sourceConfig.projects)
    const ownedProjects = nativeHomeProjectTrustEntries(ownedConfig.projects)
    const selected = new Set<string>()
    const identities = new Map<string, { dev: number; ino: number }>()
    for (const project of request.trustedProjects) {
      if (!isAbsolute(project) || selected.has(project)) {
        throw new NativeCliControlError('trust_proof_missing')
      }
      selected.add(project)
      const canonical = await realpath(project).catch(() => null)
      if (canonical !== project) {
        throw new NativeCliControlError('trust_proof_missing')
      }
      const info = await lstat(project)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new NativeCliControlError('trust_proof_missing')
      }
      identities.set(project, { dev: info.dev, ino: info.ino })
      const normalized = normalizeCodexTrustProjectPath(project)
      if (
        sourceProjects.filter((entry) => entry.normalized === normalized).length !== 1 ||
        sourceProjects.find((entry) => entry.path === project)?.level !== 'trusted' ||
        ownedProjects.some((entry) => entry.normalized === normalized)
      ) {
        throw new NativeCliControlError('trust_proof_missing')
      }
      repaired = upsertProjectTrustContent(repaired, project, 'trusted', {
        alreadyCanonical: true
      })
    }
    const after = parse(repaired)
    const afterProjects = nativeHomeProjectTrustEntries(after.projects)
    if (
      afterProjects.length !== ownedProjects.length + selected.size ||
      afterProjects.some(
        (entry) =>
          !ownedProjects.some((prior) => prior.path === entry.path) && !selected.has(entry.path)
      ) ||
      ownedProjects.some(
        (prior) =>
          JSON.stringify(afterProjects.find((entry) => entry.path === prior.path)?.data) !==
          JSON.stringify(prior.data)
      ) ||
      [...selected].some(
        (path) =>
          JSON.stringify(afterProjects.find((entry) => entry.path === path)?.data) !==
          JSON.stringify({ trust_level: 'trusted' })
      )
    ) {
      throw new NativeCliControlError('trust_proof_missing')
    }
    for (const [project, identity] of identities) {
      const current = await lstat(project).catch(() => null)
      if (
        (await realpath(project).catch(() => null)) !== project ||
        !current?.isDirectory() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      ) {
        throw new NativeCliControlError('trust_proof_missing')
      }
    }
  }
  const currentSource = (
    await readNativeHomeConfigs(manifest.sourceHome, home, options.context)
  ).files.find((file) => file.name === request.file)
  if (currentSource?.sourceHash !== source.sourceHash) {
    throw new NativeCliControlError('config_conflict')
  }
  const next = {
    ...manifest,
    configs: {
      ...manifest.configs,
      [request.file]: {
        sourceHash: source.sourceHash,
        publishedHash:
          repaired === source.contents
            ? nativeHomeDigest(repaired)
            : manifest.configs[request.file].publishedHash
      }
    }
  }
  options.assertExclusive()
  await writeNativeUserPrivate(
    markerPath,
    JSON.stringify({ version: 1, requestId: request.requestId })
  )
  await replaceNativeUserFile({
    home: storageRoot,
    path: ownedPath,
    before: owned,
    after: { bytes: Buffer.from(repaired), mode: 0o600 },
    assertExclusive: options.assertExclusive
  })
  await replaceNativeUserFile({
    home: storageRoot,
    path: manifestPath,
    before: manifestFile,
    after: { bytes: Buffer.from(JSON.stringify(next)), mode: 0o600 },
    assertExclusive: options.assertExclusive
  })
  await replaceNativeUserFile({
    home: storageRoot,
    path: markerPath,
    before: await nativeUserFile(markerPath),
    after: null,
    assertExclusive: options.assertExclusive
  })
}
