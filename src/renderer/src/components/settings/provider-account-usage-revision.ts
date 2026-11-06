import type { RateLimitState } from '../../../../shared/rate-limit-types'

export function providerAccountUsageRevision(state: RateLimitState | null | undefined): string {
  return JSON.stringify([
    state?.codex?.updatedAt,
    state?.claude?.updatedAt,
    state?.inactiveCodexAccounts?.map((entry) => entry.updatedAt),
    state?.inactiveClaudeAccounts?.map((entry) => entry.updatedAt)
  ])
}
