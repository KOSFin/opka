import type { CodexTranscriptReadBudget } from '../../shared/codex-rollout-jsonl-cursor'
import type { AccountPoolPolicy } from '../../shared/account-pool-policy'
import type { CodexHttpAccountRoute } from './codex-routing-http-server'
import {
  createCodexQuotaFailoverAttempt,
  type CodexQuotaAttemptAccount
} from './codex-quota-failover'

export type CodexHostQuotaFailure = CodexQuotaAttemptAccount & {
  code: 'usage_limit_reached'
  resetsAt?: number
}
export type CodexQuotaReplacement = CodexQuotaAttemptAccount & {
  policyRevision: number
  assignmentOwnerKey: string
  poolId: string
}
export type CodexQuotaReplacementRequest = {
  evidenceBudget?: CodexTranscriptReadBudget
  policyId: string
  expectedRevision: number
  excludedAccountIds: readonly string[]
  excludedQuotaIdentities: readonly string[]
}

/** One HTTP request retains its single finish handle through all quota-only replacements. */
export function createCodexHostQuotaRetry(options: {
  initial: { accountId: string | null; quotaIdentity: string | null }
  readPolicy: () => AccountPoolPolicy | undefined
  activeRequests: () => number
  recordFailure: (event: CodexHostQuotaFailure) => boolean
  replace: (request: CodexQuotaReplacementRequest) => CodexQuotaReplacement | null
  route: (accountId: string) => Pick<CodexHttpAccountRoute, 'port' | 'clientKey' | 'prefix'>
  onAccountSelected?: (binding: CodexQuotaReplacement) => void
  signal: AbortSignal
  finish: () => void
  holdUntilOwnerExit?: CodexHttpAccountRoute['holdUntilOwnerExit']
  prepareReplacement?: (signal: AbortSignal, budget: CodexTranscriptReadBudget) => Promise<void>
}): CodexHttpAccountRoute['retryRejectedQuota'] {
  const { accountId, quotaIdentity } = options.initial
  if (!accountId || !quotaIdentity) {
    return undefined
  }
  let replacement: CodexQuotaReplacement | null = null
  let current = { accountId, quotaIdentity }
  let confirmed = false,
    prepared = false,
    finished = false,
    running = false
  const evidenceBudget: CodexTranscriptReadBudget = { remainingBytes: 8 * 1024 * 1024 }
  const attempt = createCodexQuotaFailoverAttempt({
    initial: current,
    maxAttempts: 16,
    recordQuotaFailure: () => confirmed,
    acquireReplacement: (request) => {
      replacement = options.replace({ ...request, evidenceBudget })
      return replacement
    }
  })
  const retry: NonNullable<CodexHttpAccountRoute['retryRejectedQuota']> = async (
    failure,
    context
  ) => {
    if (finished || running) {
      return null
    }
    running = true
    try {
      try {
        confirmed = options.recordFailure({
          ...current,
          code: failure.code,
          ...(failure.resetsAt ? { resetsAt: failure.resetsAt } : {})
        })
      } catch {
        confirmed = false
      }
      let evidenceReady = true
      if (!prepared) {
        prepared = true
        evidenceBudget.expiresAt = performance.now() + 2000
        const timeout = new AbortController()
        const timer = setTimeout(() => timeout.abort(), 2000)
        const signal = AbortSignal.any([
          options.signal,
          ...(context.signal ? [context.signal] : []),
          timeout.signal
        ])
        try {
          if (
            confirmed &&
            context.allowRetry &&
            options.activeRequests() === 1 &&
            !signal.aborted
          ) {
            await options.prepareReplacement?.(signal, evidenceBudget)
          }
          evidenceReady = !signal.aborted
        } catch {
          evidenceReady = false
        } finally {
          clearTimeout(timer)
        }
      }
      const decision = attempt.retry(failure, options.readPolicy(), {
        headersSent: false,
        bytesEmitted: 0,
        acceptedTool: false,
        partialStream: false,
        cancelled: options.signal.aborted || context.signal?.aborted === true,
        otherRequestsActive: !context.allowRetry || !evidenceReady || options.activeRequests() !== 1
      })
      if (decision.kind !== 'retry') {
        finished = true
        return null
      }
      current = decision.account
      const route = options.route(current.accountId)
      if (replacement) {
        options.onAccountSelected?.(replacement)
      }
      return {
        ...route,
        ...current,
        signal: options.signal,
        finish: options.finish,
        ...(options.holdUntilOwnerExit ? { holdUntilOwnerExit: options.holdUntilOwnerExit } : {}),
        retryRejectedQuota: retry
      }
    } catch (error) {
      finished = true
      throw error
    } finally {
      running = false
    }
  }
  return retry
}
