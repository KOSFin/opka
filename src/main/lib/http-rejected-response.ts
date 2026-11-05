import type { ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeHttpResponseWithinByteBudget } from './http-response-byte-budget'

/** Retain only a bounded rejection prefix; oversized responses remain streamable. */
export async function readHttpRejectedResponse(
  response: Readable,
  limit: number,
  timeoutMs: number
) {
  const chunks: Buffer[] = []
  let total = 0
  let remainder: Buffer | undefined
  const timer = setTimeout(
    () => response.destroy(new Error('Local engine error body deadline')),
    timeoutMs
  )
  try {
    for await (const chunk of response.iterator({ destroyOnReturn: false })) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const available = limit - total
      if (part.length > available) {
        chunks.push(part.subarray(0, available))
        total += available
        remainder = part.subarray(available)
        break
      }
      chunks.push(part)
      total += part.length
    }
  } finally {
    clearTimeout(timer)
  }
  const body = Buffer.concat(chunks, total)
  return { body, remainder }
}

export async function forwardHttpRejectedResponse(
  response: Readable,
  outgoing: ServerResponse,
  captured: Awaited<ReturnType<typeof readHttpRejectedResponse>>,
  maxBytes: number
) {
  async function* bytes() {
    yield captured.body
    if (captured.remainder) {
      yield captured.remainder
      yield* response
    }
  }
  await pipeHttpResponseWithinByteBudget(Readable.from(bytes()), outgoing, maxBytes)
}
