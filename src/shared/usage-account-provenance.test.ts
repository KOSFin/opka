import { expect, it } from 'vitest'
import {
  usageAccountProvenance,
  usageMatchesAccount,
  inactiveUsageMatchesAccount
} from './usage-account-provenance'
import type { ProviderRateLimits } from './rate-limit-types'

it.each([
  ['host', null, 'system'],
  ['host', 'a', 'profile:a'],
  ['wsl:Ubuntu', null, 'wsl:Ubuntu:system'],
  ['wsl:Ubuntu', 'a', 'profile:a:wsl:Ubuntu']
])('scopes quota proof to runtime and profile/source %s %s', (runtime, id, expected) => {
  expect(usageAccountProvenance(runtime!, id)).toBe(expected)
})
it('rejects missing proof and the previous profile in the same host', () => {
  const usage: ProviderRateLimits = {
    provider: 'codex',
    session: null,
    weekly: null,
    status: 'ok',
    error: null,
    updatedAt: 1,
    usageMetadata: { authProvenance: 'profile:a' }
  }
  expect(usageMatchesAccount(usage, 'host', 'a')).toBe(true)
  expect(usageMatchesAccount(usage, 'host', 'b')).toBe(false)
  expect(usageMatchesAccount(usage, 'wsl:Ubuntu', 'a')).toBe(false)
  expect(usageMatchesAccount({ ...usage, usageMetadata: undefined }, 'host', 'a')).toBe(false)
})

it('accepts legacy ID-attributed inactive usage but rejects explicit contradictory profile/runtime proof', () => {
  expect(inactiveUsageMatchesAccount({}, 'host', 'b')).toBe(true)
  expect(inactiveUsageMatchesAccount({ usageMetadata: {} }, 'host', 'b')).toBe(true)
  expect(inactiveUsageMatchesAccount(null, 'host', 'b')).toBe(false)
  expect(
    inactiveUsageMatchesAccount({ usageMetadata: { authProvenance: 'profile:b' } }, 'host', 'b')
  ).toBe(true)
  expect(
    inactiveUsageMatchesAccount({ usageMetadata: { authProvenance: 'profile:a' } }, 'host', 'b')
  ).toBe(false)
  expect(
    inactiveUsageMatchesAccount(
      { usageMetadata: { authProvenance: 'profile:b:wsl:Ubuntu' } },
      'host',
      'b'
    )
  ).toBe(false)
  expect(inactiveUsageMatchesAccount({ usageMetadata: { authProvenance: '' } }, 'host', 'b')).toBe(
    false
  )
})
