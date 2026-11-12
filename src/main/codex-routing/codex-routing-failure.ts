import type { ServerResponse } from 'node:http'

export type CodexRoutingFailurePhase = 'admission' | 'engine-headers' | 'engine-body'
const safeFailureCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ABORT_ERR',
  'HPE_HEADER_OVERFLOW',
  'ERR_STREAM_PREMATURE_CLOSE',
  'RECOVERY_QUEUE_TIMEOUT'
])

/** Report only fixed categories; provider errors may contain credentials or request contents. */
export function codexRoutingFailureMessage(
  error: unknown,
  phase: CodexRoutingFailurePhase
): string {
  const code =
    error instanceof Error && error.message === 'Local engine header deadline'
      ? 'HEADER_DEADLINE'
      : error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string' &&
          safeFailureCodes.has(error.code)
        ? error.code
        : 'UNCLASSIFIED'
  return `Account routing failed (${phase}/${code}); check the execution host diagnostics.`
}

export function rejectCodexRoutingRequest(
  response: ServerResponse,
  status: number,
  message: string
): void {
  if (!response.headersSent && !response.destroyed) {
    response.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
    response.end(JSON.stringify({ error: { type: 'opka_account_routing', message } }))
  } else {
    response.destroy()
  }
}
