import { expect, it } from 'vitest'
import { nativeHomeProjectTrustEntries } from './codex-native-home-project-trust'

it('detects Windows path aliases without granting trust on the current host', () => {
  const entries = nativeHomeProjectTrustEntries({
    'C:\\Users\\owner\\repo': { trust_level: 'trusted' },
    'c:/users/owner/repo': { trust_level: 'trusted' }
  })
  expect(entries).toHaveLength(2)
  expect(entries[0]?.normalized).toBe(entries[1]?.normalized)
})
