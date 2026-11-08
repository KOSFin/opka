import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { formatResetCreditExpiry } from './tooltip'

export { getCodexAccountSyncKey } from './provider-account-sync-key'

export function getCodexResetProjection(codex: ProviderRateLimits): {
  resetCreditCount: number | null
  resetCreditExpiry: string | null
} {
  const resetCreditCount = codex.rateLimitResetCredits?.availableCount ?? null
  const resetCreditExpiry =
    resetCreditCount !== null
      ? formatResetCreditExpiry(codex.rateLimitResetCredits?.nextExpiresAt, resetCreditCount)
      : null
  return {
    resetCreditCount,
    resetCreditExpiry
  }
}
