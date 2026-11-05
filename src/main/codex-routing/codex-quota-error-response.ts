import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  readHttpRejectedResponse,
  forwardHttpRejectedResponse
} from '../lib/http-rejected-response'
import { CODEX_FAILURE_BODY_LIMIT, classifyCodexEngineFailure } from './codex-quota-failover'

/** Only the bounded complete JSON error can authorize another provider request. */
export async function readCodexQuotaError(
  response: IncomingMessage,
  limit: number,
  timeoutMs: number
) {
  const captured = await readHttpRejectedResponse(
    response,
    Math.min(CODEX_FAILURE_BODY_LIMIT, limit),
    timeoutMs
  )
  return {
    ...captured,
    failure: captured.remainder
      ? null
      : classifyCodexEngineFailure({
          status: 429,
          contentType: String(response.headers['content-type'] ?? ''),
          body: captured.body,
          complete: response.complete
        })
  }
}
export async function forwardCodexQuotaError(
  response: IncomingMessage,
  outgoing: ServerResponse,
  captured: Awaited<ReturnType<typeof readCodexQuotaError>>,
  maxBytes: number
) {
  await forwardHttpRejectedResponse(response, outgoing, captured, maxBytes)
}
