import { QUALIFIED_NATIVE_CLAUDE_VERSION } from '../../shared/native-claude-capability'
import { isAbsolute } from 'node:path'
export type ClaudeNativeQualifiedLaunch = { command: string; args: string[]; version: string }
export async function resolveClaudeNativeQualifiedLaunch(options: {
  assertExclusive: () => void
  resolve: () => Promise<ClaudeNativeQualifiedLaunch>
}) {
  options.assertExclusive()
  const launch = await options.resolve()
  options.assertExclusive()
  if (!isAbsolute(launch.command) || launch.version !== QUALIFIED_NATIVE_CLAUDE_VERSION) {
    throw new Error('Claude native source capability is unavailable.')
  }
  return launch
}

export function assertClaudeNativeSourceOpen(active: boolean, assertExclusive: () => void): void {
  if (!active) {
    throw new Error('Claude native sources are closed.')
  }
  assertExclusive()
}

export function assertClaudeNativeSignInIdle(pending: number): void {
  if (pending) {
    throw new Error('Native source sign-in is active.')
  }
}
