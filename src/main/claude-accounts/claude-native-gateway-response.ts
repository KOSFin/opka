import { readHttpRejectedResponse } from '../lib/http-rejected-response'
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse
} from 'node:http'
import type { Readable } from 'node:stream'
import { nativeCliControlErrorReply } from '../../shared/native-cli-control-error'

/** This shape only permits fresh host quota verification; it never proves exhaustion. */
export function isClaudeNativeRateLimitResponse(bytes: Buffer): boolean {
  try {
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return (
      !!body &&
      typeof body === 'object' &&
      'error' in body &&
      !!body.error &&
      typeof body.error === 'object' &&
      'type' in body.error &&
      body.error.type === 'rate_limit_error'
    )
  } catch {
    return false
  }
}

export function claudeNativeGatewayResponseHeaders(
  response: Pick<IncomingMessage, 'headers'>
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {
    'content-type': response.headers['content-type'] ?? 'application/octet-stream'
  }
  for (const [name, value] of Object.entries(response.headers)) {
    if (
      value !== undefined &&
      (['content-encoding', 'retry-after', 'x-should-retry', 'request-id', 'x-request-id'].includes(
        name
      ) ||
        /^anthropic-ratelimit-[a-z0-9-]+$/.test(name))
    ) {
      headers[name] = value
    }
  }
  return headers
}

export async function readClaudeNativeGatewayRejection(
  response: Readable & { statusCode?: number; headers: IncomingHttpHeaders },
  timeout: number
) {
  if (
    response.statusCode !== 429 ||
    !/^application\/json(?:;|$)/i.test(String(response.headers['content-type'])) ||
    (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
  ) {
    return null
  }
  return readHttpRejectedResponse(response, 16 * 1024, timeout)
}

export function sendClaudeNativeGatewayFailure(
  out: ServerResponse,
  status: number,
  error?: unknown
) {
  const controlled = nativeCliControlErrorReply(error)
  if (controlled) {
    status = 409
  }
  if (out.headersSent || out.destroyed) {
    out.destroy()
  } else {
    out.writeHead(status, { 'content-type': 'application/json', connection: 'close' }).end(
      JSON.stringify({
        error: {
          type: 'opka_account_routing',
          message:
            controlled?.message ??
            (status === 413
              ? 'Native request exceeds the local 8 MiB payload limit.'
              : status === 503
                ? 'Local native routing is busy; no provider request was sent.'
                : status === 415
                  ? 'Compressed or chunked local requests are unsupported.'
                  : 'Native account routing is unavailable.')
        }
      })
    )
  }
}
