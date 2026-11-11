import type { CodexEngineFailure } from './codex-quota-failover'
import type { CodexRequestTurnIdentity } from './codex-request-turn-identity'
import type { CodexReplaySpoolBudget } from './codex-replay-spool'

export type CodexHttpAccountRoute = {
  port: number
  clientKey: string
  prefix: string
  finish: () => void
  /** Keep the binding until the execution host proves its owner process exited. */
  holdUntilOwnerExit?: () => Promise<void>
  signal?: AbortSignal
  accountId?: string
  quotaIdentity?: string
  retryRejectedQuota?: (
    failure: Extract<CodexEngineFailure, { kind: 'quota' }>,
    context: { allowRetry: boolean; signal?: AbortSignal }
  ) => CodexHttpAccountRoute | null | Promise<CodexHttpAccountRoute | null>
}
export type CodexRoutingHttpOptions = {
  maxConcurrent: number
  nativeClientKey?: string
  maxRequestBytes: number
  maxResponseBytes: number
  responseHeaderTimeoutMs: number
  onCleanupUnverifiable: () => void
  /** Available only after a patched engine with seekable-body support is verified. */
  replayBudget?: CodexReplaySpoolBudget
  /** Only ready host-owned state: this must not start unbounded async preparation. */
  prepare: (
    token: string,
    request: {
      model: string
      turn?: CodexRequestTurnIdentity
      compact: boolean
    }
  ) => CodexHttpAccountRoute
}
