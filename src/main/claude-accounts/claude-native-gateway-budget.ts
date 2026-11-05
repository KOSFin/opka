import type { IncomingHttpHeaders } from 'node:http'

const MAX_REQUEST_BYTES = 8 * 1024 * 1024
const MAX_RESIDENT_BYTES = 192 * 1024 * 1024
let active = 0,
  resident = 0

/** Shared across launches: includes raw chunks, concat, UTF-16 scanner values and retry output. */
export function claimClaudeNativeGatewayRequest(length: number) {
  const charge = length * 16 + 128 * 1024
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > MAX_REQUEST_BYTES ||
    active >= 16 ||
    charge > MAX_RESIDENT_BYTES - resident
  ) {
    return null
  }
  active++
  resident += charge
  let held = true
  return () => {
    if (held) {
      held = false
      active--
      resident -= charge
    }
  }
}

export function readClaudeNativeGatewayBudget() {
  return { active, resident, maxResident: MAX_RESIDENT_BYTES, maxRequestBytes: MAX_REQUEST_BYTES }
}
export function admitClaudeNativeGatewayBody(
  headers: IncomingHttpHeaders
): { status: 413 | 415 | 503 } | { length: number; release: () => void } {
  const length = Number(headers['content-length'])
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_REQUEST_BYTES) {
    return { status: 413 as const }
  }
  if (
    headers['transfer-encoding'] ||
    (headers['content-encoding'] && headers['content-encoding'] !== 'identity')
  ) {
    return { status: 415 as const }
  }
  const release = claimClaudeNativeGatewayRequest(length)
  return release ? { length, release } : { status: 503 as const }
}
