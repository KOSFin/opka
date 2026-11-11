import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ZstdDecompress } from 'node:zlib'
import { z } from 'zod'
import { rejectCodexRoutingRequest as reject } from './codex-routing-failure'
import { CodexReplayAdmissionError, type CodexReplaySpool } from './codex-replay-spool'
import type { CodexRoutingHttpOptions } from './codex-routing-http-types'

const ModelRequest = z.object({ model: z.string().min(1).max(200) }).passthrough()
export type CodexLegacyModelRequest = z.infer<typeof ModelRequest>

async function readRequest(request: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > limit) {
      return null
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total)
}

export async function readCodexRoutingIngress(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: CodexRoutingHttpOptions,
  state: { replay?: CodexReplaySpool },
  decoder?: ZstdDecompress
): Promise<{ model: string; payload?: CodexLegacyModelRequest } | null> {
  if (options.replayBudget) {
    const replay = options.replayBudget.acquire()
    state.replay = replay
    const onUploadEnd = () => incoming.setTimeout(0)
    incoming.once('end', onUploadEnd)
    try {
      incoming.setTimeout(options.responseHeaderTimeoutMs, () =>
        incoming.destroy(new Error('Local replay upload idle deadline'))
      )
      let model: string | undefined
      if (decoder) {
        // Native decompression can report an error after its iterator rejects.
        decoder.on('error', () => {})
        const onError = (error: Error) => decoder.destroy(error)
        const onClose = () => {
          incoming.off('error', onError)
          if (!incoming.complete) {
            decoder.destroy(new Error('Compressed replay upload ended early.'))
          }
        }
        incoming.once('error', onError)
        incoming.once('close', onClose)
        incoming.pipe(decoder)
        try {
          model = (await replay.ingest(decoder)).model
        } finally {
          incoming.unpipe(decoder)
          decoder.destroy()
          if (!incoming.complete) {
            incoming.resume()
          }
        }
      } else {
        model = (await replay.ingest(incoming.iterator({ destroyOnReturn: false }))).model
      }
      if (!model) {
        throw new Error('Decoded replay body is incomplete.')
      }
      return { model }
    } catch (error) {
      reject(
        outgoing,
        error instanceof CodexReplayAdmissionError ? error.status : 400,
        error instanceof CodexReplayAdmissionError
          ? error.message
          : 'A complete valid Responses request is required.'
      )
      return null
    } finally {
      incoming.off('end', onUploadEnd)
      incoming.setTimeout(0)
    }
  }
  const bytes = await readRequest(incoming, options.maxRequestBytes)
  if (!bytes) {
    reject(outgoing, 413, 'The local request byte budget was exceeded.')
    return null
  }
  let payload: CodexLegacyModelRequest
  try {
    payload = ModelRequest.parse(JSON.parse(bytes.toString('utf8')))
  } catch {
    reject(outgoing, 400, 'A valid Responses request with a model is required.')
    return null
  }
  if (typeof payload.previous_response_id === 'string') {
    reject(
      outgoing,
      409,
      'This routing transport requires the complete local conversation history.'
    )
    return null
  }
  return { model: payload.model, payload }
}
