import { resolve } from 'node:path'
import { parse } from 'smol-toml'
import { z } from 'zod'
import { CODEX_GLOBAL_FLAGS_WITH_VALUES } from './codex-global-options'

export type NativeCodexLaunchContext = {
  codexProfile?: string
  codexModelProvider?: string
  codexWorkingDirectory: string
  codexModelCatalogPath?: string
  codexResumeSessionId?: string
}

/** Forward semantic launch context only; prompts and unrelated configuration stay inside the CLI. */
export function nativeCodexLaunchContext(
  args: readonly string[],
  cwd: string
): NativeCodexLaunchContext {
  const result: NativeCodexLaunchContext = { codexWorkingDirectory: cwd }
  let catalog: string | undefined
  let resume = false
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    const argument = args[index]
    if (argument === 'resume') {
      resume = true
      continue
    }
    if (resume && z.uuid().safeParse(argument).success) {
      result.codexResumeSessionId = argument
      resume = false
      continue
    }
    const equal = argument.indexOf('=')
    const short = ['-c', '-p', '-C'].find(
      (prefix) => argument.startsWith(prefix) && argument.length > 2
    )
    const longValue = argument.startsWith('--') && equal > 2
    const name = longValue ? argument.slice(0, equal) : (short ?? argument)
    const value = longValue
      ? argument.slice(equal + 1)
      : short
        ? argument.slice(argument[2] === '=' ? 3 : 2)
        : CODEX_GLOBAL_FLAGS_WITH_VALUES.has(name)
          ? args[++index]
          : undefined
    if (value === undefined) {
      continue
    }
    if (name === '--profile' || name === '-p') {
      result.codexProfile = value
    }
    if (name === '--cd' || name === '-C') {
      if (value.startsWith('~')) {
        throw new Error('Use an expanded working directory for routed Codex.')
      }
      result.codexWorkingDirectory = resolve(cwd, value)
    }
    if (
      (name === '--config' || name === '-c') &&
      /^\s*(model_provider|model_catalog_json)\s*=/.test(value)
    ) {
      let config: Record<string, unknown>
      try {
        config = parse(value)
      } catch {
        throw new Error('Native Codex routing configuration could not be parsed.')
      }
      if (config.model_provider !== undefined) {
        result.codexModelProvider = z.string().min(1).max(256).parse(config.model_provider)
      }
      if (config.model_catalog_json !== undefined) {
        catalog = z.string().min(1).max(8192).parse(config.model_catalog_json)
      }
    }
  }
  if (catalog !== undefined) {
    result.codexModelCatalogPath = resolve(result.codexWorkingDirectory, catalog)
  }
  return result
}
