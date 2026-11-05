import { isAbsolute, join, resolve } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { rewriteRelativePathConfigValues } from '../codex/codex-config-path-reference-rewrite'
import { readNativeHomeInput, nativeHomeDigest } from './codex-native-home-inputs'

export type CodexNativeHomeContext = {
  nativeVersion: '0.166.0'
  profile?: string
  cwd?: string
  providerOverride?: string
  catalogOverride?: string
}
export type CodexNativeHomeCatalog = { path: string; origin: 'user' | 'profile' | 'cli' }
export type NativeHomeConfig = { name: string; sourceHash: string | null; contents: string }
export async function readNativeHomeConfigs(
  sourceHome: string,
  home: string,
  context: CodexNativeHomeContext
): Promise<{ files: NativeHomeConfig[]; explicitCatalog?: CodexNativeHomeCatalog }> {
  if (
    context.nativeVersion !== '0.166.0' ||
    (context.profile && !/^[A-Za-z0-9_-]{1,128}$/.test(context.profile))
  ) {
    throw new Error(
      'Native Codex routing requires a qualified version and simple native profile name.'
    )
  }
  if (context.cwd && (!isAbsolute(context.cwd) || /[\0\r\n]/.test(context.cwd))) {
    throw new Error('Native Codex context requires an absolute verified working directory.')
  }
  if (context.providerOverride && context.providerOverride !== 'openai') {
    throw new Error('Custom native providers keep their original native launch.')
  }
  const names = ['config.toml', ...(context.profile ? [`${context.profile}.config.toml`] : [])]
  const files: NativeHomeConfig[] = []
  let explicitCatalog: CodexNativeHomeCatalog | undefined
  for (const name of names) {
    const bytes = await readNativeHomeInput(join(sourceHome, name))
    if (!bytes && name !== 'config.toml') {
      throw new Error('The selected native Codex profile file is unavailable.')
    }
    const input = bytes?.toString('utf8') ?? ''
    if (bytes && !Buffer.from(input).equals(bytes)) {
      throw new Error('Native Codex configuration must be UTF-8 text.')
    }
    let config
    try {
      config = parse(input)
    } catch {
      throw new Error(
        'Native Codex configuration could not be parsed; original files were preserved.'
      )
    }
    if (
      config.profile !== undefined ||
      (context.profile &&
        typeof config.profiles === 'object' &&
        config.profiles !== null &&
        !Array.isArray(config.profiles) &&
        context.profile in config.profiles)
    ) {
      throw new Error(
        'Native Codex 0.166 requires a separate named profile config file, without a legacy profile selector/table.'
      )
    }
    if (typeof config.model_provider === 'string' && config.model_provider !== 'openai') {
      throw new Error('Custom native providers keep their original native launch.')
    }
    if (
      (config.forced_login_method !== undefined && config.forced_login_method !== 'api') ||
      (config.cli_auth_credentials_store !== undefined &&
        !['file', 'ephemeral'].includes(String(config.cli_auth_credentials_store)))
    ) {
      throw new Error(
        'Native Codex authentication policy conflicts with isolated local gateway authentication.'
      )
    }
    let rewritten
    try {
      rewritten = parse(rewriteRelativePathConfigValues(input, sourceHome))
    } catch {
      throw new Error('Native Codex path configuration could not be preserved.')
    }
    if (config.model_catalog_json !== undefined) {
      if (typeof config.model_catalog_json !== 'string' || !config.model_catalog_json) {
        throw new Error('The explicit native model catalog is unavailable.')
      }
      const path = isAbsolute(config.model_catalog_json)
        ? config.model_catalog_json
        : resolve(sourceHome, config.model_catalog_json)
      rewritten.model_catalog_json = path
      explicitCatalog = { path, origin: name === 'config.toml' ? 'user' : 'profile' }
    }
    // Native state must not follow copied sqlite/log paths back into the source HOME.
    rewritten.sqlite_home = join(home, 'sqlite')
    rewritten.log_dir = join(home, 'log')
    files.push({
      name,
      sourceHash: bytes ? nativeHomeDigest(bytes) : null,
      contents: stringify(rewritten)
    })
  }
  if (context.catalogOverride !== undefined) {
    if (
      !context.catalogOverride ||
      /[\0\r\n]/.test(context.catalogOverride) ||
      (!isAbsolute(context.catalogOverride) && !context.cwd)
    ) {
      throw new Error('The explicit native model catalog needs a verified working directory.')
    }
    explicitCatalog = {
      path: resolve(context.cwd ?? sourceHome, context.catalogOverride),
      origin: 'cli'
    }
  }
  return { files, ...(explicitCatalog ? { explicitCatalog } : {}) }
}
