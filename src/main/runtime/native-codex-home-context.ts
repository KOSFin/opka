import { isAbsolute, join } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { readAgentCliVersion } from '../agent-cli-version-probe'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { readCodexNativeHomeSource } from '../codex-routing/codex-native-home'
import { NativeCliControlError } from '../../shared/native-cli-control-error'

export type NativeCodexHomeContext = {
  storageRoot: string
  homeDirectory: string
  resolveSourceHome: () => string | null
  assertExclusive: () => void
}
const contexts = new WeakMap<object, NativeCodexHomeContext>()
export function installNativeCodexHomeContext(
  runtime: object,
  context: NativeCodexHomeContext
): void {
  if (contexts.has(runtime)) {
    throw new Error('Native Codex HOME context is already configured.')
  }
  contexts.set(runtime, context)
}
export function requireNativeCodexHomeContext(runtime: object): NativeCodexHomeContext {
  const context = contexts.get(runtime)
  if (!context) {
    throw new Error('Native Codex isolated HOME context is not configured.')
  }
  return context
}
export function nativeCodexHomeContext(options: {
  storageRoot: string
  resolveSourceHome?: () => string | null
  assertExclusive: () => void
}): NativeCodexHomeContext {
  return {
    ...options,
    homeDirectory: join(options.storageRoot, 'codex-routing', 'native', 'home'),
    resolveSourceHome: options.resolveSourceHome ?? (() => getSystemCodexHomePath())
  }
}
export async function assertNativeCodexPreferenceHomeUnused(
  context: NativeCodexHomeContext,
  home: string
): Promise<void> {
  context.assertExclusive()
  const source = await readCodexNativeHomeSource(context)
  if (
    source &&
    normalizeRuntimePathForComparison(source) ===
      normalizeRuntimePathForComparison(await realpath(home))
  ) {
    throw new Error(
      'This account HOME is still the native CLI preference source. Import its settings elsewhere before removal.'
    )
  }
  context.assertExclusive()
}
export async function qualifyNativeCodexExecutable(
  executable: string | undefined,
  context: NativeCodexHomeContext
): Promise<{ nativeVersion: '0.166.0'; executable: string }> {
  if (!executable || !isAbsolute(executable)) {
    throw new Error('The actual native Codex executable is required.')
  }
  context.assertExclusive()
  const path = await realpath(executable)
  const before = await lstat(path)
  if (!before.isFile()) {
    throw new Error('The native Codex executable is unavailable.')
  }
  const { version } = await readAgentCliVersion({
    program: path,
    env: { ...process.env, CODEX_HOME: context.homeDirectory }
  })
  const after = await lstat(path)
  context.assertExclusive()
  if (
    version !== '0.166.0' ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new NativeCliControlError('unsupported')
  }
  return { nativeVersion: '0.166.0', executable: path }
}
