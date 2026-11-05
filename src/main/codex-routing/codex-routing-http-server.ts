import { readCodexNativeHttpRequest } from './codex-native-http-authentication'
import { retryCodexQuotaBeforeDeadline } from './codex-quota-retry-deadline'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import type { CodexEngineFailure } from './codex-quota-failover'
import { readCodexQuotaError, forwardCodexQuotaError } from './codex-quota-error-response'
import { codexRoutingHeaders } from './codex-routing-http-headers'
import { CodexNativeAffinityCapacityError } from './codex-native-affinity-capacity-error'
import { CodexTurnBoundaryError } from './codex-turn-boundary-error'
import {
  readCodexRequestTurnIdentity,
  type CodexRequestTurnIdentity
} from './codex-request-turn-identity'

const ModelRequest = z.object({ model: z.string().min(1).max(200) }).passthrough()
export type CodexHttpAccountRoute = {
  port: number
  clientKey: string
  prefix: string
  finish: () => void
  signal?: AbortSignal
  accountId?: string
  quotaIdentity?: string
  retryRejectedQuota?: (
    failure: Extract<CodexEngineFailure, { kind: 'quota' }>,
    context: { allowRetry: boolean; signal?: AbortSignal }
  ) => CodexHttpAccountRoute | null | Promise<CodexHttpAccountRoute | null>
}
export type CodexRoutingHttpOptions = {
  maxConcurrent: number
  nativeClientKey?: string
  maxRequestBytes: number
  maxResponseBytes: number
  responseHeaderTimeoutMs: number
  onCleanupUnverifiable: () => void
  /** Only ready host-owned state: this must not start unbounded async preparation. */
  prepare: (
    token: string,
    request: {
      model: string
      turn?: CodexRequestTurnIdentity
      compact: boolean
    }
  ) => CodexHttpAccountRoute
}

function reject(response: ServerResponse, status: number, message: string): void {
  if (!response.headersSent && !response.destroyed) {
    response.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
    response.end(JSON.stringify({ error: { type: 'opka_account_routing', message } }))
  } else {
    response.destroy()
  }
}
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

/** Local HTTP Responses transport only; no history cache or WebSocket translation. */
export function createCodexRoutingHttpServer(options: CodexRoutingHttpOptions) {
  const { maxConcurrent, maxRequestBytes, maxResponseBytes, responseHeaderTimeoutMs } = options
  if (
    !Number.isInteger(maxConcurrent) ||
    maxConcurrent < 1 ||
    maxConcurrent > 16 ||
    !Number.isSafeInteger(maxRequestBytes) ||
    maxRequestBytes < 1 ||
    maxRequestBytes > 32 * 1024 * 1024 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > 64 * 1024 * 1024 ||
    maxConcurrent * maxRequestBytes > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(responseHeaderTimeoutMs) ||
    responseHeaderTimeoutMs < 1 ||
    responseHeaderTimeoutMs > 300_000
  ) {
    throw new Error('Codex routing HTTP resource budget is invalid')
  }
  let active = 0
  const server = createServer(
    {
      maxHeaderSize: 32_768,
      requestTimeout: 30_000,
      headersTimeout: 10_000,
      keepAliveTimeout: 1000
    },
    async (incoming, outgoing) => {
      const identity = readCodexNativeHttpRequest(
        incoming.url,
        incoming.headers.authorization,
        options.nativeClientKey,
        incoming.method
      )
      if ('status' in identity) {
        reject(outgoing, identity.status, 'A valid local routing session is required.')
        return
      }
      const { token, compact } = identity
      if (
        incoming.headers['content-encoding'] &&
        incoming.headers['content-encoding'] !== 'identity'
      ) {
        reject(outgoing, 415, 'Compressed requests are not supported by this local transport.')
        return
      }
      if (active >= maxConcurrent) {
        reject(
          outgoing,
          429,
          'The host routing request budget is busy; no provider request was sent.'
        )
        return
      }
      active++
      let route: CodexHttpAccountRoute | undefined
      let upstream: ReturnType<typeof request> | undefined
      const requestController = new AbortController()
      const cancel = () => {
        requestController.abort()
        upstream?.destroy()
      }
      let routeSignal: AbortSignal | undefined
      outgoing.once('close', cancel)
      try {
        const bytes = await readRequest(incoming, maxRequestBytes)
        if (!bytes) {
          reject(outgoing, 413, 'The local request byte budget was exceeded.')
          return
        }
        let payload: z.infer<typeof ModelRequest>
        try {
          payload = ModelRequest.parse(JSON.parse(bytes.toString('utf8')))
        } catch {
          reject(outgoing, 400, 'A valid Responses request with a model is required.')
          return
        }
        if (typeof payload.previous_response_id === 'string') {
          reject(
            outgoing,
            409,
            'This routing transport requires the complete local conversation history.'
          )
          return
        }
        if (outgoing.destroyed) {
          return
        }
        route = options.prepare(token, {
          model: payload.model,
          turn: readCodexRequestTurnIdentity(incoming.headers['x-codex-turn-metadata']),
          compact
        })
        const visited = new Set<string>()
        for (let attempt = 0; attempt < 16; attempt++) {
          if (route.signal?.aborted || outgoing.destroyed) {
            return
          }
          routeSignal?.removeEventListener('abort', cancel)
          routeSignal = route.signal
          routeSignal?.addEventListener('abort', cancel, { once: true })
          if (
            !Number.isInteger(route.port) ||
            route.port < 1 ||
            route.port > 65535 ||
            !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(route.prefix) ||
            !/^[A-Za-z0-9._-]{32,512}$/.test(route.clientKey)
          ) {
            throw new Error('Host route configuration is invalid')
          }
          const body = JSON.stringify({ ...payload, model: `${route.prefix}/${payload.model}` })
          upstream = request({
            host: '127.0.0.1',
            port: route.port,
            path: compact ? '/v1/responses/compact' : '/v1/responses',
            method: 'POST',
            signal: route.signal,
            headers: {
              ...codexRoutingHeaders(incoming.headers),
              authorization: `Bearer ${route.clientKey}`,
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body)
            }
          })
          const response = await new Promise<IncomingMessage>((resolve, reject) => {
            const timeout = setTimeout(
              () => upstream?.destroy(new Error('Local engine header deadline')),
              responseHeaderTimeoutMs
            )
            const clear = () => clearTimeout(timeout)
            upstream?.once('response', (response) => {
              clear()
              resolve(response)
            })
            upstream?.once('error', (error) => {
              clear()
              reject(error)
            })
            upstream?.once('close', () => {
              clear()
              reject(new Error('Local engine request closed'))
            })
            upstream?.end(body)
          })
          const contentType = String(response.headers['content-type'] ?? '')
          if (response.statusCode === 429 && /^application\/json(?:\s*;|$)/i.test(contentType)) {
            const captured = await readCodexQuotaError(
              response,
              maxResponseBytes,
              responseHeaderTimeoutMs
            )
            const failure = captured.failure
            if (failure?.kind === 'quota' && !outgoing.destroyed && !route.signal?.aborted) {
              if (route.quotaIdentity) {
                visited.add(route.quotaIdentity)
              }
              const next = await retryCodexQuotaBeforeDeadline(
                route,
                failure,
                attempt < 15 && Boolean(route.quotaIdentity),
                requestController.signal,
                responseHeaderTimeoutMs
              )
              if (next && attempt < 15 && next.quotaIdentity && !visited.has(next.quotaIdentity)) {
                route = next
                upstream.destroy()
                continue
              }
            }
            outgoing.writeHead(429, codexRoutingHeaders(response.headers))
            await forwardCodexQuotaError(response, outgoing, captured, maxResponseBytes)
            break
          }
          outgoing.writeHead(response.statusCode ?? 502, codexRoutingHeaders(response.headers))
          let sent = 0
          const budget = new Transform({
            transform(chunk, _encoding, done) {
              sent += chunk.length
              done(
                sent > maxResponseBytes ? new Error('Local response byte budget exceeded') : null,
                chunk
              )
            }
          })
          await pipeline(response, budget, outgoing)
          break
        }
      } catch (error) {
        reject(
          outgoing,
          error instanceof CodexTurnBoundaryError
            ? 409
            : error instanceof CodexNativeAffinityCapacityError
              ? 429
              : 502,
          error instanceof CodexTurnBoundaryError ||
            error instanceof CodexNativeAffinityCapacityError
            ? error.message
            : 'Account routing is unavailable; check the execution host account settings.'
        )
      } finally {
        outgoing.off('close', cancel)
        requestController.abort()
        routeSignal?.removeEventListener('abort', cancel)
        upstream?.destroy()
        try {
          route?.finish()
        } catch {
          try {
            options.onCleanupUnverifiable()
          } catch {
            /* A diagnostic cannot keep a request slot live. */
          }
        } finally {
          active--
        }
      }
    }
  )
  server.maxConnections = 64
  server.on('upgrade', (_incoming, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  return server
}
