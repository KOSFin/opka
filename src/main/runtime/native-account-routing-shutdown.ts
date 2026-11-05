import {
  beginRuntimeCodexEngineShutdown,
  peekRuntimeCodexEngineHost,
  stopRuntimeCodexEngineHost
} from './runtime-codex-engine-host'
import {
  getRuntimeClaudeNativeSources,
  shutdownRuntimeClaudeNativeSources
} from './runtime-claude-native-sources'
import {
  getRuntimeNativeCliUserIntegration,
  shutdownRuntimeNativeCliUserIntegration
} from './configure-native-cli-user-integration'
import { hasNativeCliStdioSessions, stopNativeCliStdioSessions } from './native-cli-stdio-host'

/** The profile lock stays held until every credential and shell-profile mutation has settled. */
export function beginNativeAccountRoutingShutdown(
  runtime: { stopAccountDeviceSignIns?: () => Promise<unknown> | null } | null | undefined
): Promise<void> | null {
  if (!runtime) {
    return null
  }
  const shell = getRuntimeNativeCliUserIntegration(runtime)
    ? shutdownRuntimeNativeCliUserIntegration(runtime)
    : null
  const stdio = hasNativeCliStdioSessions(runtime) ? stopNativeCliStdioSessions(runtime) : null
  const claude = getRuntimeClaudeNativeSources(runtime)
    ? stdio
      ? stdio.then(() => shutdownRuntimeClaudeNativeSources(runtime))
      : shutdownRuntimeClaudeNativeSources(runtime)
    : null
  const codex = peekRuntimeCodexEngineHost(runtime) !== null
  if (codex) {
    beginRuntimeCodexEngineShutdown(runtime)
  }
  const signIns = runtime.stopAccountDeviceSignIns?.() ?? null
  return signIns || shell || claude || codex || stdio
    ? Promise.all([
        signIns,
        shell,
        claude,
        stdio,
        codex ? stopRuntimeCodexEngineHost(runtime) : null
      ]).then(() => {})
    : null
}
