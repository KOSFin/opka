export type ClaudeNativeGatewayRoute = {
  accountId: string
  quotaIdentity: string
  accountUuid: string
  accessToken: string
  /** Capture final admission synchronously immediately before the provider POST. */
  beforeSend: () => void
  /** Synchronous host proof/CAS; never writes the native facade. */
  accepted: () => void
  /** HTTP finish only; current launch occupancy remains owned. */
  finish: (verdict: 'not-sent' | 'rejected' | 'accepted' | 'unverifiable') => void
}
export type ClaudeNativeGatewayOptions = {
  capability: string
  nativeAccountUuid: string
  prepare: (
    request: { model: string; sessionId: string; parentSessionId?: string; messageCount: number },
    signal: AbortSignal
  ) => Promise<ClaudeNativeGatewayRoute>
  retryRejected: (context: {
    route: ClaudeNativeGatewayRoute
    body: Buffer
    excludedQuotaIdentities: readonly string[]
    signal: AbortSignal
  }) => Promise<ClaudeNativeGatewayRoute | null>
  totalTimeoutMs?: number
}
