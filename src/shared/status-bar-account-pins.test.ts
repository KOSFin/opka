import { expect, it } from 'vitest'
import { normalizeStatusBarAccountPins, statusBarAccountPinKey } from './status-bar-account-pins'
const pin = {
  owner: 'local',
  provider: 'codex',
  runtimeKey: 'host',
  accountId: 'one',
  label: 'One'
}
it('defaults to contextual display and rejects invalid/provider-unsupported entries', () => {
  expect(normalizeStatusBarAccountPins(undefined)).toEqual([])
  expect(
    normalizeStatusBarAccountPins([
      null,
      {},
      { ...pin, provider: 'unsupported' },
      { ...pin, owner: 'bad' },
      { ...pin, runtimeKey: 'bad' }
    ])
  ).toEqual([])
})
it('bounds, deduplicates identities and strips unrecognized fields', () => {
  const input = Array.from({ length: 100 }, (_, index) => ({
    ...pin,
    accountId: String(index),
    secret: 'not-persisted'
  }))
  const pins = normalizeStatusBarAccountPins([pin, pin, ...input])
  expect(pins).toHaveLength(64)
  expect(Object.keys(pins[2])).not.toContain('secret')
  expect(normalizeStatusBarAccountPins([{ ...pin, label: 'x'.repeat(161) }])).toEqual([])
})
it('keeps owner, runtime, provider and dynamic CLI-login source separate', () => {
  const pins = normalizeStatusBarAccountPins([
    pin,
    { ...pin, owner: 'environment:local' },
    { ...pin, runtimeKey: 'wsl:ubuntu' },
    { ...pin, provider: 'claude' },
    { ...pin, accountId: null }
  ])
  expect(new Set(pins.map(statusBarAccountPinKey)).size).toBe(5)
})
