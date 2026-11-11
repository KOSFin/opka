import { expect, it } from 'vitest'
import type { AccountPoolCandidate } from '../../shared/account-pool-policy'
import { rankQuotaEqualizeMembersWithReason } from './account-pool-quota-equalize'

function entry(accountId: string, fiveHour: number, weekly: number) {
  const candidate: AccountPoolCandidate = {
    accountId,
    quotaIdentity: accountId,
    auth: 'ready',
    quota: 'available',
    usedPercent: Math.max(fiveHour, weekly),
    quotaWindows: [
      { windowMinutes: 300, verifiedDurationMinutes: 300, usedPercent: fiveHour, resetsAt: null },
      { windowMinutes: 10080, verifiedDurationMinutes: 10080, usedPercent: weekly, resetsAt: null }
    ]
  }
  return { candidate, active: 0, sequence: 0, weight: 1 }
}

it('reports the compared maximum from complete 5h and 7d windows', () => {
  const current = entry('current', 80, 10)
  const lower = entry('lower', 20, 30)
  const decision = rankQuotaEqualizeMembersWithReason([current, lower], 'current')
  expect(decision.ranked[0].candidate.accountId).toBe('lower')
  expect(decision.reason).toContain('5h and 7d')
  expect(decision.reason).toContain('Selected account 30% used')
  expect(decision.reason).toContain('current account 80% used')
})

it('explains the conservative shared-identity score rather than an alias reading', () => {
  const alias = entry('alias', 5, 5)
  const sameIdentity = entry('same', 50, 50)
  const separate = entry('separate', 20, 20)
  sameIdentity.candidate.quotaIdentity = alias.candidate.quotaIdentity
  const decision = rankQuotaEqualizeMembersWithReason([alias, sameIdentity, separate], 'alias')
  expect(decision.ranked[0].candidate.accountId).toBe('separate')
  expect(decision.reason).toContain('Selected account 20% used')
  expect(decision.reason).toContain('current account 50% used')
  expect(decision.reason).not.toContain('5% used')
})

it('bounds a many-account explanation to the selected and current scores', () => {
  const members = Array.from({ length: 30 }, (_, index) =>
    entry(`synthetic-${index}`, index, index)
  )
  const decision = rankQuotaEqualizeMembersWithReason(members, 'synthetic-29')
  expect(decision.ranked[0].candidate.accountId).toBe('synthetic-0')
  expect(decision.reason).toContain('Selected account 0% used')
  expect(decision.reason).toContain('current account 29% used')
  expect(decision.reason).not.toContain('20% used')
  expect(decision.reason.length).toBeLessThan(220)
})

it('keeps an incomplete-set fallback free of an invented percentage', () => {
  const short = entry('short', 5, 5)
  const complete = entry('complete', 50, 50)
  short.candidate.quotaWindows?.pop()
  short.active = 1
  const decision = rankQuotaEqualizeMembersWithReason([short, complete])
  expect(decision.ranked[0].candidate.accountId).toBe('complete')
  expect(decision.reason).toContain('mismatched-window-set')
  expect(decision.reason).not.toMatch(/\d+%/)
})
