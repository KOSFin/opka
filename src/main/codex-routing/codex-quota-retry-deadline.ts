import type { CodexHttpAccountRoute } from './codex-routing-http-server'
import type { CodexEngineFailure } from './codex-quota-failover'

/** The front owns its deadline even if a host evidence callback never settles. */
export async function retryCodexQuotaBeforeDeadline(
  route: CodexHttpAccountRoute,
  failure: Extract<CodexEngineFailure, { kind: 'quota' }>,
  allowRetry: boolean,
  requestSignal: AbortSignal,
  timeoutMs: number
) {
  const deadline = new AbortController()
  const signal = AbortSignal.any([
    requestSignal,
    deadline.signal,
    ...(route.signal ? [route.signal] : [])
  ])
  let abort = () => {}
  const cancelled = new Promise<null>((resolve) => {
    abort = () => resolve(null)
    signal.addEventListener('abort', abort, { once: true })
  })
  const timer = setTimeout(() => deadline.abort(), Math.min(2000, timeoutMs))
  try {
    if (signal.aborted) {
      return null
    }
    return await Promise.race([
      route.retryRejectedQuota?.(failure, { allowRetry, signal }) ?? null,
      cancelled
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
