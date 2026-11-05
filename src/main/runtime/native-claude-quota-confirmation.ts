import { createHash } from 'node:crypto'
import type { ClaudeNativeAccessSnapshot } from '../claude-accounts/claude-native-access'
import { fetchClaudeOAuthUsage } from '../rate-limits/claude-oauth-usage-request'
import { OAuthUsageError } from '../rate-limits/claude-oauth-usage-error'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

type Current = {
  accountId: string
  sessionId: string
  owner: string
  access: ClaudeNativeAccessSnapshot
}
type Failure = { accountId: string; sessionId: string; promptId: string }
const identity = (access: ClaudeNativeAccessSnapshot) =>
  JSON.stringify([
    access.identity.accountUuid,
    access.identity.organizationUuid,
    access.identity.emailAddress.toLowerCase()
  ])
const version = (current: Current) =>
  JSON.stringify([
    current.accountId,
    current.sessionId,
    current.owner,
    identity(current.access),
    current.access.access.expiresAt,
    createHash('sha256').update(JSON.stringify(current.access)).digest('hex')
  ])

/** A model's generic 429 is not evidence that this subscription exhausted its quota. */
export function createNativeClaudeQuotaConfirmation(options: {
  readCurrent: () => Current | null
  refresh: (accountId: string, signal: AbortSignal) => Promise<ClaudeNativeAccessSnapshot>
  assertAccountOwned: (accountId: string) => void
  fetchUsage?: (token: string, signal: AbortSignal) => Promise<ProviderRateLimits>
  now?: () => number
}) {
  const lifetime = new AbortController(),
    now = options.now ?? Date.now
  let pending: { key: string; operation: Promise<boolean> } | undefined
  let cached: { key: string; value: boolean; until: number } | undefined
  let retry: { accountId: string; at: number } | undefined
  return {
    async confirm(
      failure: Failure,
      canConfirm: () => boolean,
      signal?: AbortSignal
    ): Promise<boolean> {
      const held = options.readCurrent()
      if (
        !held ||
        held.accountId !== failure.accountId ||
        held.sessionId !== failure.sessionId ||
        lifetime.signal.aborted ||
        signal?.aborted ||
        !canConfirm()
      ) {
        return false
      }
      const stamp = version(held),
        key = JSON.stringify([stamp, failure.promptId])
      const current = () => {
        const value = options.readCurrent()
        return (
          !lifetime.signal.aborted &&
          !signal?.aborted &&
          !!value &&
          version(value) === stamp &&
          canConfirm()
        )
      }
      if (retry?.accountId === failure.accountId && retry.at > now()) {
        return false
      }
      if (cached?.key === key && cached.until > now()) {
        return cached.value && current()
      }
      if (pending) {
        return pending.key === key ? (await pending.operation) && current() : false
      }
      const stop = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(12_000),
        ...(signal ? [signal] : [])
      ])
      const startedAt = now()
      const operation = (async () => {
        try {
          options.assertAccountOwned(failure.accountId)
          const access = await options.refresh(failure.accountId, stop)
          options.assertAccountOwned(failure.accountId)
          if (
            !current() ||
            stop.aborted ||
            !access.access.accessToken ||
            access.access.expiresAt <= now() ||
            identity(access) !== identity(held.access)
          ) {
            return false
          }
          const usage = await (options.fetchUsage ?? fetchClaudeOAuthUsage)(
            access.access.accessToken,
            stop
          )
          options.assertAccountOwned(failure.accountId)
          if (
            !current() ||
            stop.aborted ||
            usage.provider !== 'claude' ||
            usage.status !== 'ok' ||
            usage.error !== null ||
            usage.updatedAt < startedAt ||
            usage.updatedAt > now() + 1000
          ) {
            return false
          }
          const exhausted = [usage.session, usage.weekly].find(
            (window) =>
              window &&
              [300, 10080].includes(window.windowMinutes) &&
              Number.isFinite(window.usedPercent) &&
              window.usedPercent >= 100 &&
              window.resetsAt !== null &&
              Number.isFinite(window.resetsAt) &&
              window.resetsAt > now()
          )
          const value = !!exhausted
          cached = {
            key,
            value,
            until: Math.min(now() + (value ? 30_000 : 1000), exhausted?.resetsAt ?? Infinity)
          }
          return value
        } catch (error) {
          if (error instanceof OAuthUsageError && error.status === 429) {
            const delay = error.retryAfterMs
            retry = {
              accountId: failure.accountId,
              at:
                now() + (delay !== null && Number.isFinite(delay) ? Math.max(1000, delay) : 10_000)
            }
          }
          return false
        }
      })()
      const heldPending = { key, operation }
      pending = heldPending
      try {
        const value = await operation
        if (!value && current()) {
          cached = { key, value: false, until: now() + 1000 }
        }
        return value && current()
      } finally {
        if (pending === heldPending) {
          pending = undefined
        }
      }
    },
    close() {
      lifetime.abort()
    }
  }
}
