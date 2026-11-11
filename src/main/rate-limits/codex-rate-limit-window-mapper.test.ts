import { expect, it } from 'vitest'
import { mapCodexRateLimitWindow } from './codex-rate-limit-window-mapper'

it.each([
  [299, 300],
  [300, 300],
  [301, 300],
  [10079, 10080],
  [10080, 10080],
  [10081, 10080]
] as const)('records verified raw duration %i as %i', (raw, expected) => {
  expect(
    mapCodexRateLimitWindow({ usedPercent: 20, windowDurationMins: raw }, expected)
      ?.verifiedDurationMinutes
  ).toBe(expected)
})

it.each([undefined, '300', 302, 10082, Number.NaN])(
  'does not certify positional fallback duration %s',
  (duration) => {
    expect(
      mapCodexRateLimitWindow({ usedPercent: 20, windowDurationMins: duration }, 300)
        ?.verifiedDurationMinutes
    ).toBeUndefined()
  }
)

it('distinguishes an absent reset from malformed supplied reset metadata', () => {
  expect(
    mapCodexRateLimitWindow({ usedPercent: 20, windowDurationMins: 300 }, 300)?.resetMetadataInvalid
  ).toBeUndefined()
  expect(
    mapCodexRateLimitWindow({ usedPercent: 20, windowDurationMins: 300, resetsAt: 'tomorrow' }, 300)
      ?.resetMetadataInvalid
  ).toBe(true)
})
