import { describe, expect, it } from 'vitest'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from './automation-schedule-occurrences'

describe('automation IANA calendar occurrences', () => {
  const daily = 'FREQ=DAILY;BYHOUR=2;BYMINUTE=30'
  const start = Date.UTC(2026, 0, 1)

  it('skips a nonexistent spring wall time', () => {
    expect(
      nextAutomationOccurrenceAfter(daily, start, Date.UTC(2026, 2, 28, 12), 'Europe/Berlin')
    ).toBe(Date.UTC(2026, 2, 30, 0, 30))
  })

  it('admits only the earlier fall fold instant', () => {
    const first = Date.UTC(2026, 9, 25, 0, 30)
    const second = Date.UTC(2026, 9, 25, 1, 30)
    expect(nextAutomationOccurrenceAfter(daily, start, first - 1, 'Europe/Berlin')).toBe(first)
    expect(nextAutomationOccurrenceAfter(daily, start, first, 'Europe/Berlin')).toBe(
      Date.UTC(2026, 9, 26, 1, 30)
    )
    expect(latestAutomationOccurrenceAtOrBefore(daily, start, second, 'Europe/Berlin')).toBe(first)
  })

  it('respects a future start instant and sparse leap-day cron', () => {
    expect(
      nextAutomationOccurrenceAfter(
        '30 9 29 2 *',
        Date.UTC(2031, 0, 1),
        Date.UTC(2026, 0, 1),
        'UTC'
      )
    ).toBe(Date.UTC(2032, 1, 29, 9, 30))
  })

  it('uses the stored zone instead of the execution host zone', () => {
    const anchor = Date.UTC(2026, 5, 1, 0)
    expect(nextAutomationOccurrenceAfter(daily, start, anchor, 'UTC')).toBe(
      Date.UTC(2026, 5, 1, 2, 30)
    )
    expect(nextAutomationOccurrenceAfter(daily, start, anchor, 'America/New_York')).toBe(
      Date.UTC(2026, 5, 1, 6, 30)
    )
  })
})
