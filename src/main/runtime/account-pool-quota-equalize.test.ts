import { expect, it } from 'vitest'
import type { AccountPoolCandidate } from '../../shared/account-pool-policy'
import { rankQuotaEqualizeMembers } from './account-pool-quota-equalize'

function entry(
  accountId: string,
  percent: number | null,
  resetsAt = Date.now() + 60_000
): { candidate: AccountPoolCandidate; active: number; sequence: number; weight: number } {
  return {
    candidate: {
      accountId,
      quotaIdentity: accountId,
      auth: 'ready',
      quota: percent === null ? 'unknown' : 'available',
      usedPercent: percent,
      quotaWindows:
        percent === null
          ? undefined
          : [{ windowMinutes: 300, verifiedDurationMinutes: 300, usedPercent: percent, resetsAt }]
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

it('compares independently verified windows despite different reset dates', () => {
  const a = entry('a', 5, 86_400_000 + Date.now())
  const b = entry('b', 50, 4 * 86_400_000 + Date.now())
  a.candidate.quotaWindows = [
    {
      windowMinutes: 10080,
      verifiedDurationMinutes: 10080,
      usedPercent: 5,
      resetsAt: Date.now() + 86_400_000
    }
  ]
  b.candidate.quotaWindows = [
    {
      windowMinutes: 10080,
      verifiedDurationMinutes: 10080,
      usedPercent: 50,
      resetsAt: Date.now() + 4 * 86_400_000
    }
  ]
  expect(rankQuotaEqualizeMembers([b, a], 'b')[0].candidate.accountId).toBe('a')
  expect(rankQuotaEqualizeMembers([a, b], 'b')[0].candidate.accountId).toBe('a')
})

it('falls back to occupancy when verified window sets differ or proof is absent', () => {
  const a = entry('a', 5, Date.now() + 60_000)
  const b = entry('b', 50, Date.now() + 60_000)
  a.active = 1
  expect(rankQuotaEqualizeMembers([a, b])[0].candidate.accountId).toBe('a')
  b.candidate.quotaWindows = [
    {
      windowMinutes: 10080,
      verifiedDurationMinutes: 10080,
      usedPercent: 50,
      resetsAt: Date.now() + 86_400_000
    }
  ]
  expect(rankQuotaEqualizeMembers([a, b])[0].candidate.accountId).toBe('b')
  b.candidate.quotaWindows = [
    {
      windowMinutes: 300,
      verifiedDurationMinutes: 300,
      usedPercent: 50,
      resetsAt: Date.now() + 60_000
    },
    {
      windowMinutes: 10080,
      verifiedDurationMinutes: 10080,
      usedPercent: 50,
      resetsAt: Date.now() + 86_400_000
    }
  ]
  expect(rankQuotaEqualizeMembers([a, b])[0].candidate.accountId).toBe('b')
  b.candidate.quotaWindows = [
    { windowMinutes: 300, usedPercent: 50, resetsAt: Date.now() + 60_000 }
  ]
  expect(rankQuotaEqualizeMembers([a, b])[0].candidate.accountId).toBe('b')
})

it('does not rank unknown or invalid windows as free capacity', () => {
  expect(rankQuotaEqualizeMembers([entry('a', null), entry('b', 50)])[0].candidate.accountId).toBe(
    'b'
  )
  expect(
    rankQuotaEqualizeMembers([entry('a', 5, 1_800_000), entry('b', 50)], 'b')[0].candidate.accountId
  ).toBe('b')
})

it('treats two profiles with one quota identity as one conservative reading', () => {
  const a = entry('a', 5)
  const alias = entry('alias', 50)
  alias.candidate.quotaIdentity = 'a'
  expect(rankQuotaEqualizeMembers([a, alias, entry('b', 20)])[0].candidate.accountId).toBe('b')
  alias.candidate.quota = 'unknown'
  alias.candidate.quotaWindows = undefined
  expect(rankQuotaEqualizeMembers([a, alias, entry('b', 20)])[0].candidate.accountId).toBe('b')
})

it('uses a null reset with verified duration and reports fallback on invalid reset metadata', () => {
  const a = entry('a', 5)
  const b = entry('b', 50)
  a.candidate.quotaWindows = [
    { windowMinutes: 300, verifiedDurationMinutes: 300, usedPercent: 5, resetsAt: null }
  ]
  expect(rankQuotaEqualizeMembers([b, a])[0].candidate.accountId).toBe('a')
  a.active = 1
  a.candidate.quotaWindows = [
    { windowMinutes: 300, verifiedDurationMinutes: 300, usedPercent: 5, resetsAt: 1_800_000 }
  ]
  expect(rankQuotaEqualizeMembers([a, b])[0].candidate.accountId).toBe('b')
})

it('uses the highest percentage in identical complete 5h and 7d sets', () => {
  const a = entry('a', 10)
  const b = entry('b', 20)
  a.candidate.quotaWindows?.push({
    windowMinutes: 10080,
    verifiedDurationMinutes: 10080,
    usedPercent: 80,
    resetsAt: Date.now() + 3 * 86_400_000
  })
  b.candidate.quotaWindows?.push({
    windowMinutes: 10080,
    verifiedDurationMinutes: 10080,
    usedPercent: 30,
    resetsAt: Date.now() + 5 * 86_400_000
  })
  expect(rankQuotaEqualizeMembers([a, b])[0].candidate.accountId).toBe('b')
})

it('keeps the first choice within three points of the minimum for every input order', () => {
  for (const values of [
    [11, 8, 5],
    [11, 5, 8],
    [8, 11, 5],
    [8, 5, 11],
    [5, 11, 8],
    [5, 8, 11]
  ]) {
    const members = values.map((value) => entry(String(value), value))
    for (const current of [undefined, '11', '8', '5']) {
      const [first] = rankQuotaEqualizeMembers([...members], current)
      expect(first.candidate.usedPercent).toBeLessThanOrEqual(8)
      if (current === '5' || current === '8') {
        expect(first.candidate.accountId).toBe(current)
      }
    }
  }
})
