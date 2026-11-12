import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readCodexQuotaError, forwardCodexQuotaError } from './codex-quota-error-response'
import { retryCodexQuotaBeforeDeadline } from './codex-quota-retry-deadline'
import { codexRoutingHeaders } from './codex-routing-http-headers'
import type { CodexHttpAccountRoute, CodexRoutingHttpOptions } from './codex-routing-http-types'

type ResponseContext = {
  response: IncomingMessage
  outgoing: ServerResponse
  route: CodexHttpAccountRoute
  options: CodexRoutingHttpOptions
  requestSignal: AbortSignal
  visited: Set<string>
  attempt: number
  compact: boolean
  state: { positiveTerminal: boolean }
}

function providerTerminalProof(response: IncomingMessage, replay: boolean): boolean {
  return response.complete && (!replay || response.trailers['x-orca-provider-terminal-v1'] === '1')
}

async function forwardReplayStream(
  response: IncomingMessage,
  outgoing: ServerResponse
): Promise<void> {
  for await (const chunk of response) {
    if (outgoing.destroyed) {
      continue
    }
    if (!outgoing.write(chunk)) {
      await new Promise<void>((resolve) => {
        const cleanup = () => {
          outgoing.removeListener('drain', onDrain)
          outgoing.removeListener('close', onDrain)
          outgoing.removeListener('error', onError)
          response.removeListener('close', onDrain)
          response.removeListener('error', onDrain)
        }
        const onDrain = () => {
          cleanup()
          resolve()
        }
        const onError = () => {
          cleanup()
          resolve()
        }
        outgoing.once('drain', onDrain)
        outgoing.once('close', onDrain)
        outgoing.once('error', onError)
        response.once('close', onDrain)
        response.once('error', onDrain)
      })
    }
  }
  if (!outgoing.destroyed) {
    outgoing.end()
  }
}

export async function forwardCodexRoutingResponse({
  response,
  outgoing,
  route,
  options,
  requestSignal,
  visited,
  attempt,
  compact,
  state
}: ResponseContext): Promise<CodexHttpAccountRoute | null> {
  const { maxResponseBytes, responseHeaderTimeoutMs } = options
  const contentType = String(response.headers['content-type'] ?? '')
  if (response.statusCode === 429 && /^application\/json(?:\s*;|$)/i.test(contentType)) {
    const captured = await readCodexQuotaError(response, maxResponseBytes, responseHeaderTimeoutMs)
    const failure = captured.failure
    state.positiveTerminal =
      !captured.remainder && providerTerminalProof(response, Boolean(options.replayBudget))
    if (
      failure?.kind === 'quota' &&
      state.positiveTerminal &&
      !outgoing.destroyed &&
      !route.signal?.aborted
    ) {
      if (route.quotaIdentity) {
        visited.add(route.quotaIdentity)
      }
      const next = await retryCodexQuotaBeforeDeadline(
        route,
        failure,
        attempt < 15 && Boolean(route.quotaIdentity),
        requestSignal,
        responseHeaderTimeoutMs
      )
      if (next && attempt < 15 && next.quotaIdentity && !visited.has(next.quotaIdentity)) {
        return next
      }
    }
    outgoing.writeHead(429, codexRoutingHeaders(response.headers))
    await forwardCodexQuotaError(response, outgoing, captured, maxResponseBytes)
    state.positiveTerminal = providerTerminalProof(response, Boolean(options.replayBudget))
    return null
  }
  if (
    compact &&
    options.replayBudget &&
    (response.statusCode ?? 502) >= 200 &&
    (response.statusCode ?? 502) < 300
  ) {
    const completeResponse = options.replayBudget.acquire('response')
    try {
      response.setTimeout(responseHeaderTimeoutMs, () =>
        response.destroy(new Error('Local compact body idle deadline'))
      )
      await completeResponse.ingest(response, 'response')
      if (!response.complete) {
        throw new Error('The compact response ended before its complete window.')
      }
      state.positiveTerminal = providerTerminalProof(response, true)
      if (!state.positiveTerminal) {
        throw new Error('The compact response has no verified provider terminal proof.')
      }
      outgoing.writeHead(response.statusCode ?? 502, {
        ...codexRoutingHeaders(response.headers),
        'content-length': completeResponse.bytes
      })
      await pipeline(Readable.from(completeResponse.raw()), outgoing)
    } finally {
      state.positiveTerminal ||= providerTerminalProof(response, true)
      await completeResponse.dispose()
    }
    return null
  }
  const status = response.statusCode ?? 502
  const headers = codexRoutingHeaders(response.headers)
  outgoing.writeHead(
    status,
    status === 204 || status === 304 ? headers : { ...headers, 'transfer-encoding': 'chunked' }
  )
  if (options.replayBudget) {
    response.setTimeout(responseHeaderTimeoutMs, () =>
      response.destroy(new Error('Local engine body idle deadline'))
    )
    await forwardReplayStream(response, outgoing)
    state.positiveTerminal = providerTerminalProof(response, true)
    return null
  }
  let sent = 0
  const budget = new Transform({
    transform(chunk, _encoding, done) {
      sent += chunk.length
      if (sent > maxResponseBytes) {
        const failure = new Error('Local response byte budget exceeded')
        outgoing.destroy(failure)
        response.destroy(failure)
        done(failure)
        return
      }
      done(null, chunk)
    }
  })
  await pipeline(response, budget, outgoing)
  state.positiveTerminal = providerTerminalProof(response, false)
  return null
}
