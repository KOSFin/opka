import { describe, expect, it } from 'vitest'
import { createEmptyRateLimitState } from '../../../shared/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import {
  claimCodexResetCreditTransaction,
  codexResetCreditTransactionKey,
  mergeCodexResetCreditResult,
  releaseCodexResetCreditTransaction
} from './codex-reset-credit-transaction'

const scope = {
  target: { runtime: 'host' as const, wslDistro: null },
  accountId: 'one',
  accountRevision: 1,
  offerRevision: 'v1:offer'
}

function codex(count: number): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    rateLimitResetCredits: { availableCount: count, nextExpiresAt: null },
    usageMetadata: { authProvenance: 'profile:one' },
    updatedAt: count,
    status: 'ok',
    error: null
  }
}

describe('Codex reset credit transaction', () => {
  it('isolates the in-flight lock by host pairing, target and account, not offer revision', () => {
    const key = codexResetCreditTransactionKey('environment:host', 7, scope)
    expect(claimCodexResetCreditTransaction(key)).toBe(true)
    expect(
      claimCodexResetCreditTransaction(
        codexResetCreditTransactionKey('environment:host', 7, { ...scope, offerRevision: 'v1:new' })
      )
    ).toBe(false)
    const otherAccount = codexResetCreditTransactionKey('environment:host', 7, {
      ...scope,
      accountId: 'two'
    })
    const otherPairing = codexResetCreditTransactionKey('environment:host', 8, scope)
    expect(claimCodexResetCreditTransaction(otherAccount)).toBe(true)
    expect(claimCodexResetCreditTransaction(otherPairing)).toBe(true)
    releaseCodexResetCreditTransaction(key)
    releaseCodexResetCreditTransaction(otherAccount)
    releaseCodexResetCreditTransaction(otherPairing)
  })

  it('merges only Codex when its current revision still matches', () => {
    const before = codex(2)
    const claude = { ...codex(9), provider: 'claude' as const }
    const current = { ...createEmptyRateLimitState(), codex: before, claude }
    const received = { ...createEmptyRateLimitState(), codex: codex(1) }
    const merged = mergeCodexResetCreditResult(current, before, scope, received)
    expect(merged?.codex?.rateLimitResetCredits?.availableCount).toBe(1)
    expect(merged?.claude).toBe(claude)
    expect(
      mergeCodexResetCreditResult({ ...current, codex: codex(3) }, before, scope, received)
    ).toBeNull()
    expect(
      mergeCodexResetCreditResult(
        { ...current, codexTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' } },
        before,
        scope,
        received
      )
    ).toBeNull()
  })
})
