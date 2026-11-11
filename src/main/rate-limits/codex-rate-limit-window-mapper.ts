import type { RateLimitWindow } from '../../shared/rate-limit-types'
import type { CodexRateWindowSnapshot } from './codex-rate-limit-window-classification'

export function mapCodexRateLimitWindow(
  raw: CodexRateWindowSnapshot | null | undefined,
  expectedWindowMinutes: number
): RateLimitWindow | null {
  if (!raw || typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent)) {
    return null
  }
  let resetDescription: string | null = null
  let resetsAt: number | null = null
  let resetMetadataInvalid = raw.resetsAt !== null && raw.resetsAt !== undefined

  if (typeof raw.resetsAt === 'number' && Number.isFinite(raw.resetsAt) && raw.resetsAt > 0) {
    // Why: Codex returns resetsAt as Unix seconds, not milliseconds.
    const date = new Date(raw.resetsAt * 1000)
    if (!Number.isNaN(date.getTime())) {
      resetsAt = date.getTime()
      resetMetadataInvalid = false
      const now = new Date()
      const isToday = date.toDateString() === now.toDateString()
      resetDescription = isToday
        ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : date.toLocaleDateString(undefined, {
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit'
          })
    }
  }

  return {
    usedPercent: Math.min(100, Math.max(0, raw.usedPercent)),
    // Why: older app-server builds can report canonical bucket lengths off by one minute.
    windowMinutes: expectedWindowMinutes,
    ...(typeof raw.windowDurationMins === 'number' && Number.isFinite(raw.windowDurationMins)
      ? Math.abs(raw.windowDurationMins - 300) <= 1
        ? { verifiedDurationMinutes: 300 as const }
        : Math.abs(raw.windowDurationMins - 10080) <= 1
          ? { verifiedDurationMinutes: 10080 as const }
          : {}
      : {}),
    resetsAt,
    ...(resetMetadataInvalid ? { resetMetadataInvalid: true as const } : {}),
    resetDescription
  }
}
