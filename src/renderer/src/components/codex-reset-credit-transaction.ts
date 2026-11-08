import type { CodexResetCreditExpectedScope } from '../../../shared/codex-reset-credit-scope'
import type { ProviderRateLimits, RateLimitState } from '../../../shared/rate-limit-types'
import { usageMatchesAccount } from '../../../shared/usage-account-provenance'
import { getCodexStatusRuntimeKey } from './status-bar/status-bar-runtime-targets'

const inFlightAccounts = new Set<string>()

export function codexResetCreditTransactionKey(
  ownerKey: string,
  pairingRevision: number | undefined,
  scope: CodexResetCreditExpectedScope
): string {
  return JSON.stringify([
    ownerKey,
    pairingRevision ?? null,
    scope.target.runtime,
    scope.target.wslDistro,
    scope.accountId
  ])
}

export function claimCodexResetCreditTransaction(key: string): boolean {
  if (inFlightAccounts.has(key)) {
    return false
  }
  inFlightAccounts.add(key)
  return true
}

export function releaseCodexResetCreditTransaction(key: string): void {
  inFlightAccounts.delete(key)
}

export function mergeCodexResetCreditResult(
  current: RateLimitState,
  baselineCodex: ProviderRateLimits | null,
  scope: CodexResetCreditExpectedScope,
  received: RateLimitState
): RateLimitState | null {
  const target = current.codexTarget
  if (
    current.codex !== baselineCodex ||
    target.runtime !== scope.target.runtime ||
    target.wslDistro !== scope.target.wslDistro ||
    !usageMatchesAccount(current.codex, getCodexStatusRuntimeKey(target), scope.accountId) ||
    received.codexTarget.runtime !== scope.target.runtime ||
    received.codexTarget.wslDistro !== scope.target.wslDistro ||
    (received.codex !== null &&
      !usageMatchesAccount(received.codex, getCodexStatusRuntimeKey(target), scope.accountId))
  ) {
    return null
  }
  return { ...current, codex: received.codex }
}
