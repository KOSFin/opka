import type { AccountPoolCandidate } from '../../shared/account-pool-policy'

/** Dedicated native OAuth readiness replaces legacy-profile auth, while preserving quota policy. */
export function readyNativeClaudePoolCandidates(
  candidates: AccountPoolCandidate[],
  ready: ReadonlySet<string>,
  excluded: ReadonlySet<string> = new Set()
): AccountPoolCandidate[] {
  return candidates
    .filter((candidate) => ready.has(candidate.accountId) && !excluded.has(candidate.accountId))
    .map((candidate) => ({ ...candidate, auth: 'ready' as const }))
}
