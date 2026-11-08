import { expect, it } from 'vitest'
import { rankQuotaEqualizeMembers } from './account-pool-quota-equalize'

function entry(accountId: string, percent: number | null, resetsAt = 1_800_000) {
  return {
    candidate: {
      accountId,
      quotaIdentity: accountId,
      auth: 'ready' as const,
      quota: percent === null ? ('unknown' as const) : ('available' as const),
      usedPercent: percent,
      quotaWindows:
        percent === null ? undefined : [{ windowMinutes: 300, usedPercent: percent, resetsAt }]
    },
    active: 0,
    sequence: 0,
    weight: 1
  }
}

it('chooses 5% over 50% until usage converges, then retains the current account', () => {
  expect(
    rankQuotaEqualizeMembers([entry('a', 50), entry('b', 5)], 'a')[0].candidate.accountId
  ).toBe('b')
  expect(
    rankQuotaEqualizeMembers([entry('a', 49), entry('b', 50)], 'b')[0].candidate.accountId
  ).toBe('b')
})

it('does not rank unknown or incomparable windows as free capacity', () => {
  expect(rankQuotaEqualizeMembers([entry('a', null), entry('b', 50)])[0].candidate.accountId).toBe(
    'b'
  )
  expect(
    rankQuotaEqualizeMembers([entry('a', 5, 1_800_000), entry('b', 50, 9_000_000)], 'b')[0]
      .candidate.accountId
  ).toBe('b')
})

it('treats two profiles with one quota identity as one conservative reading', () => {
  const a = entry('a', 5)
  const alias = entry('alias', 50)
  alias.candidate.quotaIdentity = 'a'
  expect(rankQuotaEqualizeMembers([a, alias, entry('b', 20)])[0].candidate.accountId).toBe('b')
})
