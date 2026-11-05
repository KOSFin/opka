import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/** Capability comparisons accept only the pinned ASCII wire alphabet. */
export function authenticateClaudeNativeGateway(
  request: IncomingMessage,
  port: number,
  capability: string
): boolean {
  const auth = request.headers.authorization ?? '',
    expected = `Bearer ${capability}`
  return (
    request.headers.host === `127.0.0.1:${port}` &&
    request.headers.origin === undefined &&
    request.method === 'POST' &&
    ['/v1/messages', '/v1/messages?beta=true'].includes(request.url ?? '') &&
    /^Bearer [A-Za-z0-9._-]{32,512}$/.test(auth) &&
    auth.length === expected.length &&
    timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
  )
}

export function claudeNativeGatewaySyntheticTarget(target: URL): URL {
  if (
    process.env.OPKA_SYNTHETIC_LOOPBACK_SCOPE !== '1' ||
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.pathname !== '/' ||
    target.search ||
    target.hash ||
    target.username ||
    target.password
  ) {
    throw new Error('Synthetic upstream requires an isolated loopback fixture.')
  }
  return new URL(target.href)
}
