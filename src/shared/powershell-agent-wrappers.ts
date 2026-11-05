import { getPowerShellClaudeShellFunction } from './claude-shell-function'
import { getPowerShellCodexShellLaunchPreflight } from './codex-shell-function'
import { getPowerShellEscapeNativeArgsFunction } from './powershell-native-argument'

/** Orca's PowerShell `codex` and `claude` wrappers, after the argument escaping both call. */
export function getPowerShellAgentWrappers(): string {
  // Keep line boundaries while leaving room for startup commands in Windows' argv budget.
  return [
    getPowerShellEscapeNativeArgsFunction(),
    getPowerShellCodexShellLaunchPreflight(),
    getPowerShellClaudeShellFunction()
  ]
    .join('\n')
    .replace(/^[ \t]+/gm, '')
}
