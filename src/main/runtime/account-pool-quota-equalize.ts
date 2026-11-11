import type { AccountPoolCandidate } from '../../shared/account-pool-policy'

type Ranked = { candidate: AccountPoolCandidate; active: number; sequence: number; weight: number }

const HYSTERESIS_PERCENT = 3

function verifiedWindows(candidate: AccountPoolCandidate, now: number): Map<number, number> | null {
  if (!candidate.quotaWindows?.length || candidate.quota === 'unknown') {
    return null
  }
  const windows = new Map<number, number>()
  for (const window of candidate.quotaWindows) {
    const duration = window.verifiedDurationMinutes
    if (
      !duration ||
      (duration !== 300 && duration !== 10080) ||
      !Number.isFinite(window.windowMinutes) ||
      Math.abs(window.windowMinutes - duration) > 1 ||
      !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 ||
      window.usedPercent > 100 ||
      window.resetMetadataInvalid ||
      (window.resetsAt !== null &&
        (!Number.isSafeInteger(window.resetsAt) ||
          window.resetsAt <= now ||
          window.resetsAt > now + (duration + 30) * 60_000)) ||
      windows.has(duration)
    ) {
      return null
    }
    windows.set(duration, window.usedPercent)
  }
  return windows
}

export function rankQuotaEqualizeMembersWithReason<T extends Ranked>(
  eligible: T[],
  preferredAccountId?: string
): { ranked: T[]; reason: string } {
  const now = Date.now()
  const windows = new Map(
    eligible.map((entry) => [entry.candidate.accountId, verifiedWindows(entry.candidate, now)])
  )
  const known = eligible.filter((entry) => entry.candidate.quota !== 'unknown')
  const reference = windows.get(known[0]?.candidate.accountId ?? '')
  const comparable = Boolean(
    reference?.size &&
    known.every((entry) => {
      const other = windows.get(entry.candidate.accountId)
      return (
        other?.size === reference.size && [...reference.keys()].every((kind) => other.has(kind))
      )
    })
  )
  const score = (entry: T) => {
    const measured = windows.get(entry.candidate.accountId)
    if (!comparable || !measured) {
      return Number.POSITIVE_INFINITY
    }
    return Math.max(...measured.values())
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
    best < Infinity &&
    (scores.get(preferred.candidate.accountId) ?? Infinity) <= best + HYSTERESIS_PERCENT
  const ranked = eligible.sort((a, b) => {
    if (!comparable) {
      const occupancy = a.active / a.weight - b.active / b.weight
      const recency = a.sequence - b.sequence
      return (
        occupancy ||
        recency ||
        Number(Boolean(windows.get(b.candidate.accountId))) -
          Number(Boolean(windows.get(a.candidate.accountId)))
      )
    }
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
  const chosen = ranked[0]
  const kinds = [...(reference?.keys() ?? [])].sort((a, b) => a - b)
  const kindLabel = kinds.map((kind) => (kind === 300 ? '5h' : '7d')).join(' and ')
  const selectedScore = chosen ? scores.get(chosen.candidate.accountId) : undefined
  const alternatives = eligible.filter(
    (entry) =>
      entry.candidate.quotaIdentity !== chosen?.candidate.quotaIdentity &&
      Number.isFinite(scores.get(entry.candidate.accountId))
  )
  const currentAlternative = alternatives.find((entry) => entry === preferred)
  const bestAlternative = alternatives.reduce<T | null>((lowest, entry) => {
    if (!lowest) {
      return entry
    }
    return (scores.get(entry.candidate.accountId) ?? Infinity) <
      (scores.get(lowest.candidate.accountId) ?? Infinity)
      ? entry
      : lowest
  }, null)
  const alternative = currentAlternative ?? bestAlternative
  const alternativeScore = alternative ? scores.get(alternative.candidate.accountId) : undefined
  const comparison =
    selectedScore !== undefined && Number.isFinite(selectedScore)
      ? ` ${chosen === preferred ? 'Current' : 'Selected'} account ${selectedScore}% used${alternativeScore !== undefined ? `; ${alternative === preferred ? 'current account' : 'best alternative'} ${alternativeScore}% used` : ''}.`
      : ''
  const fallbackCauses = new Set(
    eligible.flatMap((entry) => {
      if (entry.candidate.quotaReason) {
        return [entry.candidate.quotaReason]
      }
      if (entry.candidate.quota === 'unknown') {
        return ['unknown-quota']
      }
      return windows.get(entry.candidate.accountId) ? [] : ['unverified-duration-or-reset']
    })
  )
  const reason = !comparable
    ? `Quota comparison unavailable: ${fallbackCauses.size ? [...fallbackCauses].join(', ') : 'mismatched-window-set'}; selected by occupancy and recency, then verified measurement on a tie.`
    : chosen && scores.get(chosen.candidate.accountId) === Infinity
      ? 'Quota unknown under pool policy; selected by occupancy and recency.'
      : known.length === 1
        ? `Only one measured eligible account (${kindLabel}${selectedScore !== undefined ? `, ${selectedScore}% used` : ''}).${eligible.some((entry) => entry.candidate.quota === 'unknown') ? ' Unknown quota ranked after measured accounts.' : ''}`
        : usePreferred && chosen === preferred
          ? `Compared verified ${kindLabel} usage; retained current account within 3 percentage points.${comparison}`
          : [...scores.values()].filter((value) => value <= best + HYSTERESIS_PERCENT).length > 1
            ? `Compared verified ${kindLabel} usage; near-equal accounts selected by occupancy and recency.${comparison}`
            : `Compared verified ${kindLabel} usage; selected lower observed usage.${comparison}${eligible.some((entry) => entry.candidate.quota === 'unknown') ? ' Unknown quota ranked after measured accounts.' : ''}`
  return { ranked, reason }
}

export function rankQuotaEqualizeMembers<T extends Ranked>(
  eligible: T[],
  preferredAccountId?: string
): T[] {
  return rankQuotaEqualizeMembersWithReason(eligible, preferredAccountId).ranked
}
