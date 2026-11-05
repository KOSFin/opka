import { isNativeCodexRoutingPty } from './native-codex-routing-ownership'
import { isNativeClaudeRoutingPty } from './native-claude-routing-ownership'

export function isNativeCliRoutingPty(
  runtime: object,
  ptyId: string,
  incarnationId: string | null | undefined
): boolean {
  if (!incarnationId) {
    return false
  }
  return (
    isNativeCodexRoutingPty(runtime, ptyId, incarnationId) ||
    isNativeClaudeRoutingPty(runtime, ptyId, incarnationId)
  )
}
