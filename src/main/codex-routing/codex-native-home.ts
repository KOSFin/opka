import { realpath, readdir, lstat } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import {
  CodexNativeHomeManifestSchema as Manifest,
  type CodexNativeHomeManifest
} from './codex-native-home-manifest'
import { managedNativeConfigHash } from './codex-native-home-managed-config'
import {
  nativeUserDirectory,
  nativeUserFile,
  nativeUserInside,
  replaceNativeUserFile,
  writeNativeUserPrivate,
  type NativeUserFile
} from '../cli/native-cli-user-installation-files'
import {
  readNativeHomeConfigs,
  type CodexNativeHomeContext,
  type CodexNativeHomeCatalog
} from './codex-native-home-config'
import { nativeHomeDigest, nativeHomeMissing } from './codex-native-home-inputs'
import { adoptCodexNativeHistory, type CodexNativeHomeAdoption } from './codex-native-home-history'
import { planNativeHomeResources } from './codex-native-home-resources'
import { copyNativeHomeResources } from './codex-native-home-resource-copy'

const preparing = new Set<string>()
export type PrepareCodexNativeHomeOptions = {
  storageRoot: string
  homeDirectory: string
  sourceHome: string
  context: CodexNativeHomeContext
  assertExclusive: () => void
  resourceRoots?: readonly string[]
  adopt?: CodexNativeHomeAdoption
  prepareManagedConfig?: (home: string) => Promise<ReadonlySet<string>>
}
export type PreparedCodexNativeHome = {
  home: string
  sourceHome: string
  explicitCatalog?: CodexNativeHomeCatalog
  adopted?: Awaited<ReturnType<typeof adoptCodexNativeHistory>>
}
async function nativeHomePaths(options: { storageRoot: string; homeDirectory: string }) {
  const lexicalRoot = resolve(options.storageRoot),
    lexicalHome = resolve(options.homeDirectory)
  if (!nativeUserInside(lexicalRoot, lexicalHome)) {
    throw new Error('Native Codex HOME must stay inside its owned profile storage.')
  }
  const storageRoot = await realpath(lexicalRoot)
  return { storageRoot, home: join(storageRoot, relative(lexicalRoot, lexicalHome)) }
}
/** A fixed authless native HOME survives CLI/account switches; auth belongs to the caller. */
export async function prepareCodexNativeHome(
  options: PrepareCodexNativeHomeOptions
): Promise<PreparedCodexNativeHome> {
  const { home, storageRoot } = await nativeHomePaths(options)
  if (preparing.has(home) || preparing.size >= 64) {
    throw new Error('Native Codex HOME preparation is busy.')
  }
  preparing.add(home)
  try {
    return await prepare(options, home, storageRoot)
  } finally {
    preparing.delete(home)
  }
}
async function prepare(
  options: PrepareCodexNativeHomeOptions,
  home: string,
  storageRoot: string
): Promise<PreparedCodexNativeHome> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('Isolated native Codex HOME preparation is not qualified on this platform.')
  }
  options.assertExclusive()
  if (!nativeUserInside(storageRoot, home)) {
    throw new Error('Native Codex HOME must stay inside its owned profile storage.')
  }
  await nativeUserDirectory(storageRoot, home, true)
  const manifestPath = join(home, '.opka-native-home.json'),
    pendingPath = join(home, '.opka-native-home-pending.json')
  if (await nativeUserFile(pendingPath)) {
    throw new Error('Interrupted native Codex HOME preparation needs review; files were preserved.')
  }
  const beforeManifest = await nativeUserFile(manifestPath)
  let previous: CodexNativeHomeManifest | undefined
  if (beforeManifest) {
    try {
      previous = Manifest.parse(JSON.parse(beforeManifest.bytes.toString('utf8')))
    } catch {
      throw new Error('Native Codex HOME ownership metadata is invalid; files were preserved.')
    }
  } else if ((await readdir(home)).length) {
    throw new Error('Refusing to adopt an existing unowned native Codex HOME.')
  }
  let sourceHome = previous?.sourceHome ?? resolve(options.sourceHome)
  let sourcePresent = false
  try {
    const canonical = await realpath(sourceHome)
    if (previous && canonical !== sourceHome) {
      throw new Error('The original native preference location changed.')
    }
    sourceHome = canonical
    const info = await lstat(sourceHome)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0
    ) {
      throw new Error('The original native preference location is unavailable.')
    }
    sourcePresent = true
  } catch (error) {
    if (!nativeHomeMissing(error)) {
      throw error
    }
    if (previous?.sourcePresent) {
      throw new Error(
        'The original native preference HOME is unavailable; owned files were preserved.'
      )
    }
  }
  if (
    sourceHome === home ||
    nativeUserInside(sourceHome, home) ||
    nativeUserInside(home, sourceHome)
  ) {
    throw new Error('Native Codex source and owned HOME must be separate.')
  }
  const configs = await readNativeHomeConfigs(sourceHome, home, options.context)
  const resources = previous
    ? undefined
    : await planNativeHomeResources(sourceHome, options.resourceRoots)
  const next = {
    version: 1 as const,
    nativeVersion: '0.166.0' as const,
    sourceHome,
    sourcePresent,
    resources: previous?.resources ?? resources?.digest ?? '',
    resourceBytes: previous?.resourceBytes ?? resources?.bytes ?? 0,
    mutablePluginState: 'fresh' as const,
    configs: { ...previous?.configs }
  }
  const changes: { path: string; before: NativeUserFile | null; contents: string }[] = []
  for (const file of configs.files) {
    const path = join(home, file.name),
      current = await nativeUserFile(path),
      baseline = previous?.configs[file.name]
    if (baseline && baseline.sourceHash === file.sourceHash) {
      if (!current) {
        throw new Error('Owned native Codex preferences are unavailable; files were preserved.')
      }
      continue
    }
    if (current && (!baseline || current.sha256 !== baseline.publishedHash)) {
      throw new Error('Native Codex preferences changed in both homes; user files were preserved.')
    }
    next.configs[file.name] = {
      sourceHash: file.sourceHash,
      publishedHash: nativeHomeDigest(file.contents)
    }
    if (!current || current.sha256 !== nativeHomeDigest(file.contents)) {
      changes.push({ path, before: current, contents: file.contents })
    }
  }
  if (Object.keys(next.configs).length > 16) {
    throw new Error('Native profile preparation exceeds its fixed config bound.')
  }
  let manifest = JSON.stringify(next)
  if (manifest.length > 64 * 1024) {
    throw new Error('Native Codex HOME metadata exceeds its fixed bound.')
  }
  const needsWrite =
    !beforeManifest ||
    beforeManifest.bytes.toString('utf8') !== manifest ||
    Boolean(options.adopt) ||
    Boolean(options.prepareManagedConfig)
  if (!needsWrite) {
    const actual = await readNativeHomeConfigs(home, home, options.context)
    return {
      home,
      sourceHome,
      ...(actual.explicitCatalog ? { explicitCatalog: actual.explicitCatalog } : {})
    }
  }
  options.assertExclusive()
  await writeNativeUserPrivate(pendingPath, JSON.stringify({ version: 1 }))
  for (const change of changes) {
    await replaceNativeUserFile({
      home: storageRoot,
      path: change.path,
      before: change.before,
      after: { bytes: Buffer.from(change.contents), mode: 0o600 },
      assertExclusive: options.assertExclusive
    })
  }
  if (resources) {
    await copyNativeHomeResources({
      storageRoot,
      home,
      plan: resources,
      assertExclusive: options.assertExclusive
    })
  }
  const adopted = options.adopt
    ? await adoptCodexNativeHistory({
        storageRoot,
        home,
        adopt: options.adopt,
        assertExclusive: options.assertExclusive
      })
    : undefined
  if (options.prepareManagedConfig) {
    const path = join(home, 'config.toml')
    const before = await nativeUserFile(path)
    const keys = await options.prepareManagedConfig(home)
    const after = await nativeUserFile(path)
    const baseline = next.configs['config.toml']
    if (!before || !after || !baseline) {
      throw new Error('Managed native Codex preferences are unavailable.')
    }
    baseline.publishedHash = managedNativeConfigHash(before, after, baseline.publishedHash, keys)
    manifest = JSON.stringify(next)
  }
  const actual = await readNativeHomeConfigs(home, home, options.context)
  if (!beforeManifest || beforeManifest.bytes.toString('utf8') !== manifest) {
    await replaceNativeUserFile({
      home: storageRoot,
      path: manifestPath,
      before: beforeManifest,
      after: { bytes: Buffer.from(manifest), mode: 0o600 },
      assertExclusive: options.assertExclusive
    })
  }
  await replaceNativeUserFile({
    home: storageRoot,
    path: pendingPath,
    before: await nativeUserFile(pendingPath),
    after: null,
    assertExclusive: options.assertExclusive
  })
  return {
    home,
    sourceHome,
    ...(actual.explicitCatalog ? { explicitCatalog: actual.explicitCatalog } : {}),
    ...(adopted ? { adopted } : {})
  }
}

/** A persistent preference dependency protects its source even without a live CLI. */
export async function readCodexNativeHomeSource(options: {
  storageRoot: string
  homeDirectory: string
}): Promise<string | null> {
  const { storageRoot: root, home } = await nativeHomePaths(options)
  if (!nativeUserInside(root, home)) {
    throw new Error('Native Codex HOME ownership is unavailable.')
  }
  try {
    await nativeUserDirectory(root, home, false)
  } catch (error) {
    if (nativeHomeMissing(error)) {
      return null
    }
    throw error
  }
  if (await nativeUserFile(join(home, '.opka-native-home-pending.json'))) {
    throw new Error('Interrupted native Codex HOME preparation needs review; files were preserved.')
  }
  const file = await nativeUserFile(join(home, '.opka-native-home.json'))
  if (!file) {
    if ((await readdir(home)).length) {
      throw new Error('Native Codex HOME ownership is unavailable.')
    }
    return null
  }
  try {
    return Manifest.parse(JSON.parse(file.bytes.toString('utf8'))).sourceHome
  } catch {
    throw new Error('Native Codex HOME ownership metadata is invalid; files were preserved.')
  }
}
