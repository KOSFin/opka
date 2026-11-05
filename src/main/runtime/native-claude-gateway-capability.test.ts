import { expect, it } from 'vitest'
import { nativeClaudeGatewayCapabilitySnapshot } from './native-claude-gateway-capability'

it('keeps local capability lifetime and credentials independent of vendor access expiry/renewal', () => {
  const initial = {
    identity: {
      accountUuid: 'native-account',
      organizationUuid: 'native-org',
      emailAddress: 'a@example.invalid'
    },
    access: { accessToken: 'source-only-A', expiresAt: 1100, scopes: ['user:inference'] }
  }
  const capability = nativeClaudeGatewayCapabilitySnapshot(initial, 'local-capability', 1000)
  const renewed = {
    ...initial,
    access: { ...initial.access, accessToken: 'source-only-A2', expiresAt: 2000 }
  }
  expect(capability.access.accessToken).toBe('local-capability')
  expect(capability.access.expiresAt).toBeGreaterThan(1000 + 365 * 24 * 3600_000)
  expect(initial.access.accessToken).toBe('source-only-A')
  expect(renewed.access.accessToken).toBe('source-only-A2')
  expect(JSON.stringify(capability)).not.toContain('source-only-')
  expect(JSON.stringify(capability)).not.toContain('refreshToken')
  expect(capability.identity).toEqual(initial.identity)
})
