import { expect, it } from 'vitest'
import type { AccountPoolCandidate } from '../../shared/account-pool-policy'
import { mapCodexRateLimitWindow } from '../rate-limits/codex-rate-limit-window-mapper'
import { rankQuotaEqualizeMembersWithReason } from './account-pool-quota-equalize'

function entry(accountId: string, usedPercent: number, resetsAt: number | null) {
  const candidate: AccountPoolCandidate = {
    accountId,
    quotaIdentity: accountId,
    auth: 'ready',
    quota: 'available',
    usedPercent,
    quotaWindows: [{ windowMinutes: 10080, verifiedDurationMinutes: 10080, usedPercent, resetsAt }]
  }
  return { candidate, active: 0, sequence: 0, weight: 1 }
}

it('keeps positional unknown raw durations display-only and malformed reset distinct from absent', () => {
  for (const raw of [undefined, '10080', 10082, 302]) {
    const mapped = mapCodexRateLimitWindow({ usedPercent: 5, windowDurationMins: raw }, 10080)
    expect(mapped?.windowMinutes).toBe(10080)
    expect(mapped?.verifiedDurationMinutes).toBeUndefined()
  }
  for (const raw of [10079, 10081]) {
    expect(
      mapCodexRateLimitWindow({ usedPercent: 5, windowDurationMins: raw }, 10080)
        ?.verifiedDurationMinutes
    ).toBe(10080)
  }
  expect(
    mapCodexRateLimitWindow({ usedPercent: 5, windowDurationMins: 10080 }, 10080)
      ?.resetMetadataInvalid
  ).toBeUndefined()
  expect(
    mapCodexRateLimitWindow(
      { usedPercent: 5, windowDurationMins: 10080, resetsAt: 'invalid' },
      10080
    )?.resetMetadataInvalid
  ).toBe(true)
})

it('explains both observed percentages when selecting across independent weekly epochs', () => {
  const low = entry('low', 5, Date.now() + 86_400_000)
  const high = entry('high', 50, Date.now() + 4 * 86_400_000)
  const result = rankQuotaEqualizeMembersWithReason([high, low], 'high')
  expect(result.ranked[0].candidate.accountId).toBe('low')
  expect(result.reason).toContain('7d')
  expect(result.reason).toContain('5%')
  expect(result.reason).toContain('50%')
})

it('explains the measured gap when retaining a near-equal current account', () => {
  const low = entry('low', 49, null)
  const current = entry('current', 50, null)
  const result = rankQuotaEqualizeMembersWithReason([low, current], 'current')
  expect(result.ranked[0].candidate.accountId).toBe('current')
  expect(result.reason).toContain('49%')
  expect(result.reason).toContain('50%')
})

it('falls back without a percentage claim for a mismatched window set', () => {
  const low = entry('low', 5, null)
  const high = entry('high', 50, null)
  low.active = 1
  high.candidate.quotaWindows?.push({
    windowMinutes: 300,
    verifiedDurationMinutes: 300,
    usedPercent: 80,
    resetsAt: null
  })
  const result = rankQuotaEqualizeMembersWithReason([low, high])
  expect(result.ranked[0].candidate.accountId).toBe('high')
  expect(result.reason).toContain('mismatched-window-set')
  expect(result.reason).not.toContain('lower observed')
})
