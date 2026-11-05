import type { ServerResponse } from 'node:http'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Accepted bytes stream immediately; a later failure never restarts the provider request. */
export async function pipeHttpResponseWithinByteBudget(
  input: Readable,
  outgoing: ServerResponse,
  maxBytes: number
) {
  let sent = 0
  await pipeline(
    input,
    new Transform({
      transform(chunk, _encoding, done) {
        sent += chunk.length
        done(sent > maxBytes ? new Error('Local response byte budget exceeded') : null, chunk)
      }
    }),
    outgoing
  )
}
