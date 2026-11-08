import type { AccountPoolCandidate } from '../../shared/account-pool-policy'

type Ranked = { candidate: AccountPoolCandidate; active: number; sequence: number; weight: number }

const HYSTERESIS_PERCENT = 3
const RESET_TOLERANCE_MS = 30 * 60_000

function comparable(a: NonNullable<AccountPoolCandidate['quotaWindows']>[number], b: typeof a) {
  return (
    a.windowMinutes === b.windowMinutes &&
    (a.resetsAt === null || b.resetsAt === null
      ? a.resetsAt === b.resetsAt
      : Math.abs(a.resetsAt - b.resetsAt) <= RESET_TOLERANCE_MS)
  )
}

export function rankQuotaEqualizeMembers<T extends Ranked>(
  eligible: T[],
  preferredAccountId?: string
): T[] {
  const known = eligible.filter((entry) => entry.candidate.quotaWindows?.length)
  const reference = known[0]?.candidate.quotaWindows ?? []
  const common = reference.filter((window) =>
    known.every((entry) => entry.candidate.quotaWindows?.some((other) => comparable(window, other)))
  )
  const score = (entry: T) => {
    const windows = entry.candidate.quotaWindows
    if (!windows?.length || !common.length) {
      return Number.POSITIVE_INFINITY
    }
    return Math.max(
      ...common.map((window) =>
        Math.max(
          ...windows.filter((other) => comparable(window, other)).map((other) => other.usedPercent)
        )
      )
    )
  }
  const byIdentity = new Map<string, number>()
  for (const entry of eligible) {
    const identity = entry.candidate.quotaIdentity
    byIdentity.set(identity, Math.max(byIdentity.get(identity) ?? 0, score(entry)))
  }
  const scores = new Map(
    eligible.map((entry) => [
      entry.candidate.accountId,
      byIdentity.get(entry.candidate.quotaIdentity) ?? Infinity
    ])
  )
  const best = Math.min(...scores.values())
  const preferred = eligible.find((entry) => entry.candidate.accountId === preferredAccountId)
  const usePreferred =
    preferred &&
    (scores.get(preferred.candidate.accountId) ?? Infinity) <= best + HYSTERESIS_PERCENT
  return eligible.sort((a, b) => {
    const aScore = scores.get(a.candidate.accountId) ?? Infinity
    const bScore = scores.get(b.candidate.accountId) ?? Infinity
    if (usePreferred && a !== b) {
      if (a === preferred) {
        return -1
      }
      if (b === preferred) {
        return 1
      }
    }
    // Compare against the same minimum so three overlapping pairs cannot disagree.
    if (aScore !== bScore && Math.max(aScore, bScore) > best + HYSTERESIS_PERCENT) {
      return aScore - bScore
    }
    const occupancy = a.active / a.weight - b.active / b.weight
    return occupancy || a.sequence - b.sequence
  })
}
