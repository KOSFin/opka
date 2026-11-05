import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { usageMatchesAccount, usageAccountProvenance } from '../../shared/usage-account-provenance'

export type CodexProviderFailureEvent = {
  accountId: string
  quotaIdentity: string
  authProvenance: string
  code: 'usage_limit_reached'
  observedAt: number
  resetsAt?: number
}
export type CodexProviderFailureAccount = {
  /** Canonical quota identity from current accountPoolCandidates, backed by a verified engine connection. */
  quotaIdentity: string
  authProvenance: string
  identityVerified: true
  /** Native CLI default selection, not whichever account a gateway request currently uses. */
  selected: boolean
}
export type CodexProviderFailureAccountResolver = (
  accountId: string
) => CodexProviderFailureAccount | null

export function verifiedCodexProviderFailure(
  event: CodexProviderFailureEvent,
  proof: CodexProviderFailureAccount | null,
  now: number
): boolean {
  return Boolean(
    proof &&
    proof.identityVerified === true &&
    event.code === 'usage_limit_reached' &&
    event.accountId &&
    event.accountId.length <= 200 &&
    event.quotaIdentity &&
    event.quotaIdentity.length <= 512 &&
    proof.quotaIdentity === event.quotaIdentity &&
    proof.authProvenance === event.authProvenance &&
    event.authProvenance === usageAccountProvenance('host', event.accountId) &&
    Number.isSafeInteger(event.observedAt) &&
    event.observedAt > 0 &&
    Number.isSafeInteger(now) &&
    event.observedAt <= now + 1000 &&
    now - event.observedAt <= 30_000 &&
    (event.resetsAt === undefined ||
      (Number.isSafeInteger(event.resetsAt) &&
        event.resetsAt > event.observedAt &&
        event.resetsAt - event.observedAt <= 31 * 24 * 60 * 60_000))
  )
}

/** A rejection is quota evidence, never a measurement of percent or an invented usage window. */
export function stampedCodexProviderFailure(
  previous: ProviderRateLimits | null | undefined,
  event: CodexProviderFailureEvent
): ProviderRateLimits {
  const sample =
    previous?.provider === 'codex' && usageMatchesAccount(previous, 'host', event.accountId)
      ? previous
      : null
  return {
    ...(sample ?? {
      provider: 'codex',
      session: null,
      weekly: null,
      updatedAt: 0,
      error: 'Codex reported that this account has reached its usage limit.',
      status: 'unavailable'
    }),
    status: sample ? 'error' : 'unavailable',
    error: 'Codex reported that this account has reached its usage limit.',
    usageMetadata: {
      ...sample?.usageMetadata,
      authProvenance: event.authProvenance,
      confirmedProviderFailure: {
        kind: 'quota-exhausted',
        code: 'usage_limit_reached',
        observedAt: event.observedAt,
        quotaIdentity: event.quotaIdentity,
        ...(event.resetsAt !== undefined ? { resetsAt: event.resetsAt } : {})
      }
    }
  }
}

/** Failed/empty polling cannot turn a confirmed rejection into unknown usable quota. */
export function preserveCodexProviderFailure(
  fresh: ProviderRateLimits,
  previous: ProviderRateLimits | null
): ProviderRateLimits {
  const failure = previous?.usageMetadata?.confirmedProviderFailure
  if (
    fresh.provider !== 'codex' ||
    !failure ||
    (fresh.usageMetadata?.authProvenance &&
      fresh.usageMetadata.authProvenance !== previous?.usageMetadata?.authProvenance)
  ) {
    return fresh
  }
  const measured = Boolean(fresh.session || fresh.weekly || fresh.buckets?.length)
  if (
    fresh.status === 'ok' &&
    measured &&
    fresh.updatedAt > failure.observedAt &&
    fresh.usageMetadata?.authProvenance === previous?.usageMetadata?.authProvenance
  ) {
    return fresh
  }
  return {
    ...fresh,
    usageMetadata: {
      ...fresh.usageMetadata,
      authProvenance: previous?.usageMetadata?.authProvenance,
      confirmedProviderFailure: failure
    }
  }
}

export function clearCodexProviderFailure(sample: ProviderRateLimits): ProviderRateLimits {
  const usageMetadata = { ...sample.usageMetadata }
  delete usageMetadata.confirmedProviderFailure
  return { ...sample, usageMetadata }
}
