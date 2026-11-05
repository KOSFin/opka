import { z } from 'zod'
import type { AccountPoolPolicy } from '../../shared/account-pool-policy'
import { usageLimitResetsAt } from '../../shared/agent-session-usage-limit'

export const CODEX_FAILURE_BODY_LIMIT = 16 * 1024
const ErrorBody = z.object({
  error: z.object({
    code: z.string().nullable().optional(),
    type: z.string().optional(),
    resets_at: z.unknown().optional()
  })
})
const AUTH_CODES = new Set(['invalid_api_key', 'token_expired', 'invalid_authentication_token'])
export type CodexEngineFailure =
  | { kind: 'quota'; code: 'usage_limit_reached'; resetsAt?: number }
  | { kind: 'authentication'; code: string }

/** Messages and status codes alone do not prove provider quota exhaustion. */
export function classifyCodexEngineFailure(
  input: { status: number; contentType: string; body: Uint8Array; complete: boolean },
  now = Date.now()
): CodexEngineFailure | null {
  if (
    input.complete !== true ||
    input.body.byteLength > CODEX_FAILURE_BODY_LIMIT ||
    !/^application\/json(?:\s*;|$)/i.test(input.contentType) ||
    (input.status !== 429 && input.status !== 401)
  ) {
    return null
  }
  let parsed: z.infer<typeof ErrorBody>
  try {
    parsed = ErrorBody.parse(JSON.parse(Buffer.from(input.body).toString('utf8')))
  } catch {
    return null
  }
  const { code, type, resets_at: seconds } = parsed.error
  if (
    input.status === 429 &&
    (code === 'usage_limit_reached' || (!code && type === 'usage_limit_reached')) &&
    type !== 'authentication_error'
  ) {
    const reset = usageLimitResetsAt(typeof seconds === 'number' ? seconds * 1000 : undefined, now)
    return {
      kind: 'quota',
      code: 'usage_limit_reached',
      ...(reset && reset > now ? { resetsAt: reset } : {})
    }
  }
  const auth = code ?? type
  return input.status === 401 && auth && AUTH_CODES.has(auth)
    ? { kind: 'authentication', code: auth }
    : null
}

export type CodexQuotaAttemptAccount = { accountId: string; quotaIdentity: string }
export type CodexRetryExposure = {
  headersSent: boolean
  bytesEmitted: number
  acceptedTool: boolean
  partialStream: boolean
  cancelled: boolean
  otherRequestsActive: boolean
}
export type CodexQuotaFailoverDecision =
  | { kind: 'retry'; account: CodexQuotaAttemptAccount }
  | { kind: 'reauth-required' }
  | {
      kind: 'stop'
      reason:
        | 'unconfirmed-failure'
        | 'unsafe-request'
        | 'policy-disabled'
        | 'attempt-limit'
        | 'authority-unconfirmed'
        | 'replacement-unavailable'
        | 'invalid-replacement'
        | 'already-finished'
    }

/** Request-local attempt bookkeeping only; host quota and assignment stores remain authoritative. */
export function createCodexQuotaFailoverAttempt(options: {
  initial: CodexQuotaAttemptAccount
  maxAttempts: number
  recordQuotaFailure: (
    event: CodexQuotaAttemptAccount & { code: 'usage_limit_reached'; resetsAt?: number }
  ) => boolean
  /** Existing session/admission transaction must enforce policy, caps, and the excluded identities. */
  acquireReplacement: (request: {
    policyId: string
    expectedRevision: number
    excludedAccountIds: readonly string[]
    excludedQuotaIdentities: readonly string[]
  }) => CodexQuotaAttemptAccount | null
}) {
  if (
    !Number.isInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    options.maxAttempts > 16
  ) {
    throw new Error('Codex quota failover attempt budget must be between 1 and 16')
  }
  const valid = (account: CodexQuotaAttemptAccount) =>
    Boolean(
      account.accountId &&
      account.accountId.length <= 200 &&
      account.quotaIdentity &&
      account.quotaIdentity.length <= 512
    )
  if (!valid(options.initial)) {
    throw new Error('A verified initial account and quota identity are required')
  }
  let current = { ...options.initial },
    finished = false
  const accounts = new Set([current.accountId]),
    identities = new Set([current.quotaIdentity])
  return {
    retry(
      failure: CodexEngineFailure | null,
      policy: AccountPoolPolicy | undefined,
      exposure: CodexRetryExposure
    ): CodexQuotaFailoverDecision {
      if (finished) {
        return { kind: 'stop', reason: 'already-finished' }
      }
      const stop = (
        reason: Extract<CodexQuotaFailoverDecision, { kind: 'stop' }>['reason']
      ): CodexQuotaFailoverDecision => {
        finished = true
        return { kind: 'stop', reason }
      }
      if (!failure) {
        return stop('unconfirmed-failure')
      }
      if (failure.kind === 'authentication') {
        finished = true
        return { kind: 'reauth-required' }
      }
      let stamped = false
      try {
        stamped = options.recordQuotaFailure({
          ...current,
          code: failure.code,
          ...(failure.resetsAt ? { resetsAt: failure.resetsAt } : {})
        })
      } catch {
        return stop('authority-unconfirmed')
      }
      if (!stamped) {
        return stop('authority-unconfirmed')
      }
      if (
        exposure.headersSent !== false ||
        exposure.bytesEmitted !== 0 ||
        exposure.acceptedTool !== false ||
        exposure.partialStream !== false ||
        exposure.cancelled !== false ||
        exposure.otherRequestsActive !== false
      ) {
        return stop('unsafe-request')
      }
      if (
        !policy ||
        policy.provider !== 'codex' ||
        !policy.applyToNewWork ||
        policy.strategy === 'manual' ||
        policy.rotation === 'off'
      ) {
        return stop('policy-disabled')
      }
      if (identities.size >= Math.min(options.maxAttempts, policy.members.length)) {
        return stop('attempt-limit')
      }
      let next: CodexQuotaAttemptAccount | null
      try {
        next = options.acquireReplacement({
          policyId: policy.id,
          expectedRevision: policy.revision,
          excludedAccountIds: [...accounts],
          excludedQuotaIdentities: [...identities]
        })
      } catch {
        return stop('replacement-unavailable')
      }
      if (!next) {
        return stop('replacement-unavailable')
      }
      if (!valid(next) || accounts.has(next.accountId) || identities.has(next.quotaIdentity)) {
        return stop('invalid-replacement')
      }
      current = { ...next }
      accounts.add(next.accountId)
      identities.add(next.quotaIdentity)
      return { kind: 'retry', account: { ...current } }
    }
  }
}
