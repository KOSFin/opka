import {
  codexRoutingFailureMessage,
  rejectCodexRoutingRequest as reject,
  type CodexRoutingFailurePhase
} from './codex-routing-failure'
import { readCodexNativeHttpRequest } from './codex-native-http-authentication'
import { createServer, request, type IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants as zlibConstants, createZstdDecompress } from 'node:zlib'
import { codexRoutingHeaders } from './codex-routing-http-headers'
import { forwardCodexRoutingResponse } from './codex-routing-http-response'
import { readCodexRoutingIngress } from './codex-routing-http-ingress'
import { finishCodexRoutingRequest } from './codex-routing-http-cleanup'
import type { CodexHttpAccountRoute, CodexRoutingHttpOptions } from './codex-routing-http-types'
export type { CodexHttpAccountRoute, CodexRoutingHttpOptions } from './codex-routing-http-types'
import { CodexTurnBoundaryError } from './codex-turn-boundary-error'
import { readCodexRequestTurnIdentity } from './codex-request-turn-identity'
import { CodexReplayAdmissionError, type CodexReplaySpool } from './codex-replay-spool'
import { recordLocalCodex429 } from './codex-routing-429-diagnostic'
import { assertCodexRoutingHttpBudget } from './codex-routing-http-budget'

/** Local HTTP Responses transport only; no history cache or WebSocket translation. */
export function createCodexRoutingHttpServer(options: CodexRoutingHttpOptions) {
  assertCodexRoutingHttpBudget(options)
  const { maxConcurrent, maxRequestBytes, responseHeaderTimeoutMs } = options
  let active = 0
  const server = createServer(
    {
      maxHeaderSize: 32_768,
      requestTimeout: options.replayBudget ? 300_000 : 30_000,
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
      const contentEncoding = incoming.headers['content-encoding']
      if (
        contentEncoding &&
        (typeof contentEncoding !== 'string' ||
          !['identity', 'zstd'].includes(contentEncoding.toLowerCase()) ||
          (contentEncoding.toLowerCase() === 'zstd' && !options.replayBudget))
      ) {
        reject(outgoing, 415, 'Compressed requests are not supported by this local transport.')
        return
      }
      if (!options.replayBudget && active >= maxConcurrent) {
        recordLocalCodex429('host-budget')
        reject(
          outgoing,
          429,
          'The host routing request budget is busy; no provider request was sent.'
        )
        return
      }
      active++
      let route: CodexHttpAccountRoute | undefined
      let replay: CodexReplaySpool | undefined
      let upstream: ReturnType<typeof request> | undefined
      const requestController = new AbortController()
      const cancel = () => {
        requestController.abort()
        incoming.destroy()
        upstream?.destroy()
      }
      let routeSignal: AbortSignal | undefined
      let failurePhase: CodexRoutingFailurePhase = 'admission'
      let providerPossible = false
      let positiveTerminal = false
      let hostFailure = false
      let localDeliveryCancelled = false
      let engineClosed: Promise<void> | undefined
      const onOutgoingClose = (): void => {
        if (outgoing.writableFinished) {
          return
        }
        localDeliveryCancelled = Boolean(
          options.replayBudget &&
          !hostFailure &&
          !outgoing.errored &&
          !upstream?.destroyed &&
          !requestController.signal.aborted &&
          !routeSignal?.aborted
        )
        cancel()
      }
      outgoing.once('close', onOutgoingClose)
      try {
        const ingressState: { replay?: CodexReplaySpool } = {}
        const ingress = await readCodexRoutingIngress(
          incoming,
          outgoing,
          options,
          ingressState,
          contentEncoding?.toLowerCase() === 'zstd'
            ? createZstdDecompress({ params: { [zlibConstants.ZSTD_d_windowLogMax]: 25 } })
            : undefined
        )
        replay = ingressState.replay
        if (!ingress) {
          return
        }
        const { model, payload } = ingress
        if (outgoing.destroyed) {
          return
        }
        await options.waitForReady?.(token, requestController.signal)
        route = options.prepare(token, {
          model,
          turn: readCodexRequestTurnIdentity(incoming.headers['x-codex-turn-metadata']),
          compact
        })
        const visited = new Set<string>()
        for (let attempt = 0; attempt < 16; attempt++) {
          positiveTerminal = false
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
          if (options.replayBudget && !route.holdUntilOwnerExit) {
            throw new Error('Seekable routing needs an execution-host termination fence.')
          }
          const routePrefix = route.prefix
          const requestReplay = replay
          const body = requestReplay
            ? undefined
            : JSON.stringify({ ...payload, model: `${routePrefix}/${model}` })
          const replayModel = requestReplay?.forwardedModelSpan(routePrefix)
          if (replayModel && !compact && !replayModel.stream) {
            reject(outgoing, 422, 'Seekable non-stream Responses needs a bounded translator.')
            return
          }
          const replayDigest = requestReplay
            ? await requestReplay.forwardedSha256(routePrefix)
            : undefined
          if (body && Buffer.byteLength(body) > maxRequestBytes) {
            reject(outgoing, 413, 'The local forwarded request byte budget was exceeded.')
            return
          }
          const forwardedHeaders = codexRoutingHeaders(incoming.headers)
          if (contentEncoding?.toLowerCase() === 'zstd') {
            delete forwardedHeaders['content-encoding']
          }
          failurePhase = 'engine-headers'
          const engineRequest = request({
            host: '127.0.0.1',
            port: route.port,
            path: compact ? '/v1/responses/compact' : '/v1/responses',
            method: 'POST',
            signal: route.signal,
            headers: {
              ...forwardedHeaders,
              authorization: `Bearer ${route.clientKey}`,
              'content-type': 'application/json',
              ...(replayModel && replayDigest
                ? {
                    'x-orca-native-replay-v1': '1',
                    'x-orca-native-replay-stream': String(replayModel.stream),
                    'x-orca-native-replay-model-start': String(replayModel.start),
                    'x-orca-native-replay-model-end': String(replayModel.end),
                    'x-orca-native-replay-sha256': replayDigest
                  }
                : {}),
              'content-length': requestReplay
                ? requestReplay.forwardedBytes(routePrefix)
                : Buffer.byteLength(body ?? '')
            }
          })
          upstream = engineRequest
          engineClosed = new Promise<void>((resolve) => engineRequest.once('close', resolve))
          const responsePromise = new Promise<IncomingMessage>((resolve, reject) => {
            const timeout = setTimeout(
              () => engineRequest.destroy(new Error('Local engine header deadline')),
              responseHeaderTimeoutMs
            )
            const clear = () => clearTimeout(timeout)
            engineRequest.once('response', (response) => {
              clear()
              resolve(response)
            })
            engineRequest.once('error', (error) => {
              clear()
              reject(error)
            })
            engineRequest.once('close', () => {
              clear()
              reject(new Error('Local engine request closed'))
            })
            providerPossible = true
            if (requestReplay) {
              void pipeline(
                Readable.from(requestReplay.rewritten(routePrefix)),
                engineRequest
              ).catch((error: unknown) =>
                engineRequest.destroy(error instanceof Error ? error : undefined)
              )
            } else {
              engineRequest.end(body)
            }
          })
          const response = await responsePromise
          failurePhase = 'engine-body'
          const responseState = { positiveTerminal }
          let next: CodexHttpAccountRoute | null
          try {
            next = await forwardCodexRoutingResponse({
              response,
              outgoing,
              route,
              options,
              requestSignal: requestController.signal,
              visited,
              attempt,
              compact,
              state: responseState
            })
          } finally {
            positiveTerminal = responseState.positiveTerminal
          }
          if (next) {
            route = next
            upstream.destroy()
            providerPossible = false
            continue
          }
          break
        }
      } catch (error) {
        hostFailure = true
        if (error instanceof CodexReplayAdmissionError && error.status === 429) {
          recordLocalCodex429('replay-capacity')
        }
        reject(
          outgoing,
          error instanceof CodexTurnBoundaryError
            ? 409
            : error instanceof CodexReplayAdmissionError
              ? error.status
              : 502,
          error instanceof CodexTurnBoundaryError || error instanceof CodexReplayAdmissionError
            ? error.message
            : codexRoutingFailureMessage(error, failurePhase)
        )
      } finally {
        outgoing.off('close', onOutgoingClose)
        requestController.abort()
        routeSignal?.removeEventListener('abort', cancel)
        upstream?.destroy()
        try {
          // A cancelled native caller cannot receive tool calls; never replay that request.
          if (localDeliveryCancelled) {
            await engineClosed
          }
          await finishCodexRoutingRequest(
            options,
            route,
            replay,
            providerPossible,
            positiveTerminal,
            localDeliveryCancelled
          )
        } finally {
          active--
        }
      }
    }
  )
  // Buffered legacy requests retain their admission bound; native streams use backpressure.
  if (!options.replayBudget) {
    server.maxConnections = 64
  }
  server.on('upgrade', (_incoming, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  return server
}
