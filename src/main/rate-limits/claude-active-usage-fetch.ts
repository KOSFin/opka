import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  readClaudeOAuthCredentials,
  resolveClaudeOAuthCredentialReadOptions
} from './claude-oauth-credentials'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import { classifyClaudeOAuthUsageError } from './claude-usage-error-classification'
import { OAuthUsageError } from './claude-oauth-usage-error'
import type { ClaudeRateLimitFetchOptions } from './claude-usage-fetch-options'
import { abortedClaudeRateLimitResult, makeClaudeUsageResult } from './claude-usage-result'
import { CLAUDE_PROFILE_MISSING_MESSAGE } from '../../shared/claude-profile-routing'

/** Read access credentials only; native login refresh belongs to the owning authority. */
export async function fetchActiveClaudeRateLimits(
  options?: ClaudeRateLimitFetchOptions
): Promise<ProviderRateLimits> {
  const usageError = options?.authPreparation?.usageError
  if (usageError) {
    return makeClaudeUsageResult('error', usageError, {
      failureKind:
        usageError === CLAUDE_PROFILE_MISSING_MESSAGE ? 'missing-credentials' : 'usage-unavailable',
      attemptedSources: []
    })
  }
  if (options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  const credentials = await readClaudeOAuthCredentials(
    resolveClaudeOAuthCredentialReadOptions(options?.authPreparation)
  )
  const metadata = {
    credentialSource: credentials.source,
    authProvenance: options?.authPreparation?.provenance ?? 'system'
  }
  // Why: System Default with no Claude login is an API-key or non-Claude user, not a signed-out account.
  if (
    !credentials.token &&
    !credentials.unavailable &&
    !credentials.hasRefreshableCredentials &&
    metadata.authProvenance === 'system'
  ) {
    return makeClaudeUsageResult('unavailable', 'No subscription plan — API key billing', {
      ...metadata,
      failureKind: 'missing-credentials',
      attemptedSources: []
    })
  }
  if (!credentials.token) {
    return makeClaudeUsageResult(
      'error',
      credentials.unavailable
        ? 'Claude usage is unavailable.'
        : 'Sign in again to use this account.',
      {
        ...metadata,
        failureKind: credentials.unavailable ? 'keychain-unavailable' : 'missing-credentials',
        attemptedSources: []
      }
    )
  }
  try {
    const result = await fetchClaudeOAuthUsage(credentials.token, options?.signal)
    return { ...result, usageMetadata: { ...result.usageMetadata, ...metadata } }
  } catch (error) {
    const { failureKind } = classifyClaudeOAuthUsageError(error)
    // Why: the 429 wait gates the poll, and both messages tell the user why usage is missing.
    const retryAfterMs = error instanceof OAuthUsageError ? error.retryAfterMs : null
    return makeClaudeUsageResult(
      'error',
      failureKind === 'stale-token'
        ? // Why: Claude refreshes its own login when it next runs; System Default has no "account".
          metadata.authProvenance === 'system'
          ? 'Claude usage updates the next time Claude runs.'
          : 'Claude usage has expired. Start Claude in this account to refresh it.'
        : (failureKind === 'rate-limited' || failureKind === 'missing-scope') &&
            error instanceof OAuthUsageError
          ? error.message
          : 'Claude usage is unavailable.',
      {
        ...metadata,
        failureKind,
        attemptedSources: ['oauth'],
        ...(retryAfterMs ? { retryAtMs: Date.now() + retryAfterMs } : {})
      }
    )
  }
}
