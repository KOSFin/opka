import {
  authenticateClaudeNativeGateway,
  claudeNativeGatewaySyntheticTarget
} from './claude-native-gateway-authentication'
import { createServer } from 'node:http'
import { shutdownClaudeNativeGateway } from './claude-native-gateway-shutdown'
import { openClaudeNativeGatewayExchange } from './claude-native-gateway-exchange'
import { pipeHttpResponseWithinByteBudget } from '../lib/http-response-byte-budget'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { forwardHttpRejectedResponse } from '../lib/http-rejected-response'
import {
  sendClaudeNativeGatewayFailure as unavailable,
  claudeNativeGatewayResponseHeaders as responseHeaders,
  readClaudeNativeGatewayRejection as rejection,
  isClaudeNativeRateLimitResponse
} from './claude-native-gateway-response'
import { admitClaudeNativeGatewayBody } from './claude-native-gateway-budget'
import {
  claudeNativeGatewayHeaders,
  readClaudeNativeGatewayRequest
} from './claude-native-gateway-request'

import type {
  ClaudeNativeGatewayRoute,
  ClaudeNativeGatewayOptions
} from './claude-native-gateway-route'
export type {
  ClaudeNativeGatewayRoute,
  ClaudeNativeGatewayOptions
} from './claude-native-gateway-route'

/** Only the production entry can select a provider destination. */
export function startClaudeNativeGatewayHttp(options: ClaudeNativeGatewayOptions) {
  return start(options, new URL('https://api.anthropic.com'))
}
export function startClaudeNativeGatewayHttpForTest(
  options: ClaudeNativeGatewayOptions,
  target: URL
) {
  return start(options, claudeNativeGatewaySyntheticTarget(target))
}
async function start(options: ClaudeNativeGatewayOptions, target: URL) {
  if (!/^[A-Za-z0-9._-]{32,512}$/.test(options.capability)) {
    throw new Error('Native gateway capability is invalid.')
  }
  const total = options.totalTimeoutMs ?? 180_000
  if (!Number.isInteger(total) || total < 1 || total > 300_000) {
    throw new Error('Native gateway deadline is invalid.')
  }
  const revoked = new AbortController()
  let active = 0,
    retryBarrier = false
  const cleanups = new Set<Promise<void>>()
  let closing: Promise<void> | undefined
  const server = createServer(
    {
      maxHeaderSize: 16 * 1024,
      headersTimeout: 10_000,
      requestTimeout: 30_000,
      keepAliveTimeout: 1000
    },
    async (incoming, outgoing) => {
      const address = server.address()
      if (
        !address ||
        typeof address === 'string' ||
        revoked.signal.aborted ||
        !authenticateClaudeNativeGateway(incoming, address.port, options.capability)
      ) {
        unavailable(outgoing, 401)
        return
      }
      if (retryBarrier) {
        unavailable(outgoing, 503)
        return
      }
      const admission = admitClaudeNativeGatewayBody(incoming.headers)
      if ('status' in admission) {
        unavailable(outgoing, admission.status)
        return
      }
      const { length, release } = admission
      active++
      let holdsBarrier = false
      let releaseDrain = () => {}
      const drained = new Promise<void>((resolve) => {
        releaseDrain = resolve
      })
      cleanups.add(drained)
      const abort = new AbortController()
      const signal = AbortSignal.any([abort.signal, revoked.signal, AbortSignal.timeout(total)])
      const cancel = () => abort.abort()
      outgoing.once('close', cancel)
      let route: ClaudeNativeGatewayRoute | undefined
      let pendingOperation: Promise<unknown> | undefined
      const interrupt = () => {
        incoming.destroy()
      }
      signal.addEventListener('abort', interrupt, { once: true })
      let closeBody: (() => Promise<void>) | undefined
      let finished = false
      let verdict: Parameters<ClaudeNativeGatewayRoute['finish']>[0] = 'not-sent'
      const finish = () => {
        if (route && !finished) {
          finished = true
          try {
            route.finish(verdict)
          } catch {
            revoked.abort()
          }
        }
      }
      try {
        const chunks: Buffer[] = []
        let read = 0
        for await (const chunk of incoming) {
          if (signal.aborted || (read += chunk.length) > length) {
            throw new Error('Native upload exceeded its declared budget.')
          }
          chunks.push(chunk)
        }
        if (read !== length) {
          throw new Error('Native upload was incomplete.')
        }
        const bytes = Buffer.concat(chunks, read)
        chunks.length = 0
        const parsed = readClaudeNativeGatewayRequest(bytes, options.nativeAccountUuid)
        const prepared = options.prepare(parsed, signal).then((ready) => {
          if (signal.aborted) {
            ready.finish('not-sent')
            throw new Error('Native preparation was cancelled.')
          }
          return ready
        })
        pendingOperation = prepared
        let current = await waitForPromiseWithSignal(prepared, signal)
        route = current
        pendingOperation = undefined
        const visited = new Set<string>()
        for (let attempt = 0; attempt < 16; attempt++) {
          if (signal.aborted || visited.has(current.quotaIdentity)) {
            throw new Error('Native attempt authority changed.')
          }
          visited.add(current.quotaIdentity)
          const body = parsed.forAccount(current.accountUuid)
          verdict = 'not-sent'
          const headers = {
            ...claudeNativeGatewayHeaders(incoming.headers, current.accessToken),
            'accept-encoding': 'identity',
            'content-length': body.length
          }
          const response = await openClaudeNativeGatewayExchange({
            target,
            path: incoming.url ?? '/v1/messages',
            headers,
            body,
            signal,
            timeoutMs: Math.min(30_000, total),
            beforeSend: () => {
              current.beforeSend()
              verdict = 'unverifiable'
            }
          })
          closeBody = response.closeBody
          const rejected = await rejection(response, total)
          if (rejected) {
            if (response.complete && !rejected.remainder) {
              await closeBody?.()
              closeBody = undefined
              verdict = 'rejected'
              finish()
            }
            const mayReplace =
              active === 1 &&
              !signal.aborted &&
              parsed.portable &&
              attempt < 15 &&
              !rejected.remainder &&
              response.complete &&
              isClaudeNativeRateLimitResponse(rejected.body)
            if (mayReplace) {
              retryBarrier = true
              holdsBarrier = true
            }
            const pending: Promise<ClaudeNativeGatewayRoute | null> = mayReplace
              ? options
                  .retryRejected({
                    route: current,
                    body: rejected.body,
                    excludedQuotaIdentities: [...visited],
                    signal
                  })
                  .then((ready) => {
                    if (signal.aborted) {
                      ready?.finish('not-sent')
                      return null
                    }
                    return ready
                  })
              : Promise.resolve(null)
            pendingOperation = pending
            const next: ClaudeNativeGatewayRoute | null = await waitForPromiseWithSignal(
              pending,
              signal
            )
            pendingOperation = undefined
            if (signal.aborted) {
              next?.finish('not-sent')
              throw new Error('Native retry was cancelled.')
            }
            if (next) {
              current = next
              route = current
              finished = false
              await closeBody?.()
              closeBody = undefined
              continue
            }
            outgoing.writeHead(response.statusCode ?? 429, responseHeaders(response))
            await forwardHttpRejectedResponse(response, outgoing, rejected, 64 * 1024 * 1024)
            if (response.complete) {
              verdict = 'rejected'
            }
            break
          }
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            verdict = 'accepted'
            current.accepted()
          }
          outgoing.writeHead(response.statusCode ?? 502, responseHeaders(response))
          await pipeHttpResponseWithinByteBudget(response, outgoing, 64 * 1024 * 1024)
          if (response.complete && response.statusCode && response.statusCode >= 400) {
            verdict = 'rejected'
          }
          break
        }
      } catch (error) {
        unavailable(outgoing, 502, error)
      } finally {
        outgoing.off('close', cancel)
        signal.removeEventListener('abort', interrupt)
        abort.abort()
        let bodyClosed = true
        try {
          await closeBody?.()
        } catch {
          bodyClosed = false
          verdict = 'unverifiable'
          revoked.abort()
          finish()
        }
        const settled = () => {
          try {
            finish()
          } finally {
            active--
            if (holdsBarrier) {
              retryBarrier = false
            }
            release()
            cleanups.delete(drained)
            releaseDrain()
          }
        }
        if (bodyClosed) {
          if (pendingOperation) {
            void pendingOperation.then(settled, settled)
          } else {
            settled()
          }
        }
      }
    }
  )
  server.maxConnections = 16
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('upgrade', (_request, socket) => socket.destroy())
  server.on('connect', (_request, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Native loopback listener is unavailable.')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    readActiveRequests: () => active,
    revoke: () => revoked.abort(),
    close: () => (closing ??= shutdownClaudeNativeGateway(server, revoked, cleanups))
  }
}
