import type { ClaudeNativeAccessSnapshot } from '../claude-accounts/claude-native-access'

const LOCAL_VALIDITY_MS = 10 * 365 * 24 * 3600_000

/** The local capability expires by host revocation, independently of provider access renewal. */
export function nativeClaudeGatewayCapabilitySnapshot(
  source: ClaudeNativeAccessSnapshot,
  capability: string,
  now = Date.now()
): ClaudeNativeAccessSnapshot {
  return {
    identity: source.identity,
    access: {
      accessToken: capability,
      expiresAt: now + LOCAL_VALIDITY_MS,
      scopes: [...source.access.scopes],
      subscriptionType: source.access.subscriptionType,
      rateLimitTier: source.access.rateLimitTier
    }
  }
}
