import { parseSchedule, type ParsedSchedule } from './automation-schedule-parsing'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const MAX_SCAN_DAYS = 9 * 366

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number }

function partsAt(formatter: Intl.DateTimeFormat, instant: number): ZonedParts {
  const parts: ZonedParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0 }
  for (const part of formatter.formatToParts(instant)) {
    if (part.type === 'year') {
      parts.year = Number(part.value)
    }
    if (part.type === 'month') {
      parts.month = Number(part.value)
    }
    if (part.type === 'day') {
      parts.day = Number(part.value)
    }
    if (part.type === 'hour') {
      parts.hour = Number(part.value)
    }
    if (part.type === 'minute') {
      parts.minute = Number(part.value)
    }
  }
  return parts
}

function matchingInstants(
  formatter: Intl.DateTimeFormat,
  offsets: readonly number[],
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number[] {
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute)
  const instants: number[] = []
  for (const offset of offsets) {
    const instant = wallUtc - offset
    const actual = partsAt(formatter, instant)
    if (
      actual.year === year &&
      actual.month === month &&
      actual.day === day &&
      actual.hour === hour &&
      actual.minute === minute
    ) {
      instants.push(instant)
    }
  }
  return instants.length > 0 ? [Math.min(...instants)] : []
}

function offsetsForDay(formatter: Intl.DateTimeFormat, dayUtc: number): number[] {
  const offsets = new Set<number>()
  for (const sample of [dayUtc - 36 * HOUR_MS, dayUtc, dayUtc + 36 * HOUR_MS]) {
    const local = partsAt(formatter, sample)
    offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - sample)
  }
  return [...offsets]
}

function dayMatches(rule: ParsedSchedule, dayUtc: number): boolean {
  const day = new Date(dayUtc)
  const weekday = day.getUTCDay()
  if (rule.kind === 'rrule') {
    const codes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
    return rule.freq !== 'WEEKLY' || rule.byDay.includes(codes[weekday])
  }
  if (!rule.months.has(day.getUTCMonth() + 1)) {
    return false
  }
  const dateMatches = rule.daysOfMonth.has(day.getUTCDate())
  const weekdayMatches = rule.daysOfWeek.has(weekday)
  return rule.dayOfMonthRestricted && rule.dayOfWeekRestricted
    ? dateMatches || weekdayMatches
    : dateMatches && weekdayMatches
}

function hoursFor(rule: ParsedSchedule): number[] {
  if (rule.kind === 'cron') {
    return [...rule.hours].sort((a, b) => a - b)
  }
  return rule.freq === 'HOURLY' ? Array.from({ length: 24 }, (_, hour) => hour) : [rule.byHour]
}

function minutesFor(rule: ParsedSchedule): number[] {
  return rule.kind === 'cron' ? [...rule.minutes].sort((a, b) => a - b) : [rule.byMinute]
}

/** Resolve calendar wall times to UTC; gaps vanish and folds use the earlier instant. */
export function automationOccurrenceInZone(
  rrule: string,
  dtstart: number,
  anchor: number,
  timeZone: string,
  direction: 'next' | 'latest'
): number | null {
  if (direction === 'latest' && anchor < dtstart) {
    return null
  }
  const rule = parseSchedule(rrule)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
  if (rule.kind === 'cron' && rule.hours.size === 24 && rule.minutes.size === 60) {
    let candidate =
      direction === 'next'
        ? Math.ceil(Math.max(anchor + 1, dtstart) / MINUTE_MS) * MINUTE_MS
        : Math.floor(anchor / MINUTE_MS) * MINUTE_MS
    for (let minute = 0; minute < 180; minute += 1) {
      const local = partsAt(formatter, candidate)
      const dayUtc = Date.UTC(local.year, local.month - 1, local.day)
      if (
        candidate >= dtstart &&
        dayMatches(rule, dayUtc) &&
        matchingInstants(
          formatter,
          offsetsForDay(formatter, dayUtc),
          local.year,
          local.month,
          local.day,
          local.hour,
          local.minute
        )[0] === candidate
      ) {
        return candidate
      }
      candidate += direction === 'next' ? MINUTE_MS : -MINUTE_MS
    }
  }
  const local = partsAt(formatter, direction === 'next' ? Math.max(anchor, dtstart - 1) : anchor)
  const firstDay = Date.UTC(local.year, local.month - 1, local.day)
  const hours = hoursFor(rule)
  const minutes = minutesFor(rule)
  const step = direction === 'next' ? 1 : -1
  for (let index = 0; index < MAX_SCAN_DAYS; index += 1) {
    const dayUtc = firstDay + index * step * DAY_MS
    if (!dayMatches(rule, dayUtc)) {
      continue
    }
    const day = new Date(dayUtc)
    const offsets = offsetsForDay(formatter, dayUtc)
    let best: number | null = null
    for (const hour of hours) {
      for (const minute of minutes) {
        for (const instant of matchingInstants(
          formatter,
          offsets,
          day.getUTCFullYear(),
          day.getUTCMonth() + 1,
          day.getUTCDate(),
          hour,
          minute
        )) {
          if (instant < dtstart || (direction === 'next' ? instant <= anchor : instant > anchor)) {
            continue
          }
          if (best === null || (direction === 'next' ? instant < best : instant > best)) {
            best = instant
          }
        }
      }
    }
    if (best !== null) {
      return best
    }
  }
  return null
}
