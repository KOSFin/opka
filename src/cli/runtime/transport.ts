import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { findTransport, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import type {
  ExpectedRuntimeSource,
  RuntimeOrchestrationEnvelope
} from '../../shared/runtime-rpc-envelope'
import { isKeepaliveFrame, RuntimeRpcEnvelopeSchema } from './envelope-schema'
import { RuntimeClientError, type RuntimeRpcResponse } from './types'
import { MAX_TIMER_DELAY_MS, isSafeTimerDelayMs } from '../../shared/timer-delay'
import { runtimeAccessDeniedError } from './runtime-access-denied'

export async function sendRequest<TResult>(
  metadata: RuntimeMetadata,
  method: string,
  params: unknown,
  timeoutMs: number,
  envelope?: RuntimeOrchestrationEnvelope,
  // Why separate from the envelope: federation forwards envelopes to other runtimes.
  expectedRuntimeSource?: ExpectedRuntimeSource,
  stream?: {
    onFrame(result: unknown): void | Promise<void>
    signal?: AbortSignal
    pauseTimeoutWhileConsuming?: boolean
  }
): Promise<RuntimeRpcResponse<TResult>> {
  if (!isSafeTimerDelayMs(timeoutMs)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Runtime request timeout must be an integer between 0 and ${MAX_TIMER_DELAY_MS}ms.`
    )
  }
  return await new Promise((resolve, reject) => {
    const transport = findTransport(metadata, 'unix', 'named-pipe')
    if (!transport) {
      reject(
        new RuntimeClientError(
          'runtime_unavailable',
          'No compatible transport found in Orca runtime metadata.'
        )
      )
      return
    }
    const socket = createConnection(transport.endpoint)
    let lineSegments: string[] = []
    let partialChars = 0
    let waitingForConsumer = false
    let settled = false
    const requestId = randomUUID()

    let timeout: ReturnType<typeof setTimeout> | undefined
    const armTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        if (settled) {
          return
        }
        settled = true
        lineSegments = []
        stream?.signal?.removeEventListener('abort', abort)
        socket.destroy()
        reject(
          new RuntimeClientError(
            'runtime_timeout',
            'Timed out waiting for the Orca runtime to respond.'
          )
        )
      }, timeoutMs)
    }
    armTimeout()

    const finish = (
      result: { ok: true; response: RuntimeRpcResponse<TResult> } | { ok: false; error: Error }
    ): void => {
      if (settled) {
        return
      }
      settled = true
      lineSegments = []
      clearTimeout(timeout)
      stream?.signal?.removeEventListener('abort', abort)
      socket.end()
      if (result.ok === false) {
        reject(result.error)
      } else {
        resolve(result.response)
      }
    }
    const abort = (): void => {
      socket.destroy()
      finish({
        ok: false,
        error: new RuntimeClientError('runtime_stream_aborted', 'Runtime stream detached')
      })
    }
    socket.setEncoding('utf8')
    socket.once('error', (error) => {
      finish({
        ok: false,
        // Why: a sandbox denying the socket/pipe is not a dead app, so restart advice would mislead.
        error:
          runtimeAccessDeniedError(error, metadata.pid) ??
          new RuntimeClientError(
            'runtime_unavailable',
            'Could not connect to the running Orca app. Restart Orca and try again.'
          )
      })
    })
    // Why: a clean peer close (FIN, no 'error') before a terminal frame never
    // settles the promise, so the call would otherwise hang until the full
    // timeout fires. Reject promptly. finish() guards double-settle, so this
    // no-ops on the normal success/error paths that already called socket.end().
    socket.once('close', () => {
      finish({
        ok: false,
        error: new RuntimeClientError(
          'runtime_unavailable',
          'The Orca runtime closed the connection before responding. Restart Orca and try again.'
        )
      })
    })
    const receive = (chunk: string): void => {
      // Why: the server may interleave `{"_keepalive":true}\n` frames with the
      // final success/failure frame to keep both idle timers alive during a
      // long-poll (see design doc §3.1). Read frames in a loop until we see a
      // terminal frame. Each keepalive refreshes the client-side timer so a
      // 10 min wait doesn't trip the 60 s default ceiling.
      let cursor = 0
      while (cursor < chunk.length && !settled) {
        const newlineIndex = chunk.indexOf('\n', cursor)
        if (newlineIndex === -1) {
          lineSegments.push(chunk.slice(cursor))
          partialChars += chunk.length - cursor
          if (stream && partialChars > 8 * 1024 * 1024) {
            finish({
              ok: false,
              error: new RuntimeClientError(
                'invalid_runtime_response',
                'Runtime stream frame exceeded its limit'
              )
            })
          }
          return
        }
        const segment = chunk.slice(cursor, newlineIndex)
        let line = segment
        if (lineSegments.length > 0) {
          lineSegments.push(segment)
          line = lineSegments.join('')
          lineSegments = []
        }
        partialChars = 0
        if (stream && line.length > 8 * 1024 * 1024) {
          finish({
            ok: false,
            error: new RuntimeClientError(
              'invalid_runtime_response',
              'Runtime stream frame exceeded its limit'
            )
          })
          return
        }
        cursor = newlineIndex + 1
        if (line.trim().length === 0) {
          continue
        }

        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          finish({
            ok: false,
            error: new RuntimeClientError(
              'invalid_runtime_response',
              'The Orca runtime returned an invalid response frame.'
            )
          })
          return
        }

        // Fast-path: ignore keepalives without running the full schema.
        // setTimeout().refresh() is stable since Node 10 (Orca ships on
        // Node 20+ via Electron and the standalone CLI targets the same
        // major). See §7 risk #9.
        if (isKeepaliveFrame(raw)) {
          timeout?.refresh()
          continue
        }

        // Why: validate the envelope shape (id, ok, result/error, _meta) at
        // the decode boundary so version skew between the CLI and the Orca
        // main runtime surfaces as a single invalid_runtime_response instead
        // of a downstream mis-typed field access. `result` is left as
        // unknown — the TResult generic is the caller's responsibility.
        const parsed = RuntimeRpcEnvelopeSchema.safeParse(raw)
        if (!parsed.success) {
          finish({
            ok: false,
            error: new RuntimeClientError(
              'invalid_runtime_response',
              'The Orca runtime returned an invalid response frame.'
            )
          })
          return
        }

        // Narrow out keepalive (already filtered above) so TS can see a
        // Success|Failure shape here.
        const frame = parsed.data
        if ('_keepalive' in frame) {
          timeout?.refresh()
          continue
        }

        const response = frame as RuntimeRpcResponse<TResult>
        if (response.id !== requestId) {
          finish({
            ok: false,
            error: new RuntimeClientError(
              'invalid_runtime_response',
              'The Orca runtime returned a mismatched response id.'
            )
          })
          return
        }
        if (response._meta?.runtimeId && response._meta.runtimeId !== metadata.runtimeId) {
          finish({
            ok: false,
            error: new RuntimeClientError(
              'runtime_unavailable',
              'The Orca runtime changed while the request was in flight. Retry the command.'
            )
          })
          return
        }
        if (
          stream &&
          response.ok &&
          typeof raw === 'object' &&
          raw !== null &&
          'streaming' in raw &&
          raw.streaming === true
        ) {
          try {
            const pending = stream.onFrame(response.result)
            if (pending instanceof Promise) {
              waitingForConsumer = true
              if (stream.pauseTimeoutWhileConsuming) {
                clearTimeout(timeout)
                timeout = undefined
              }
              socket.pause()
              void pending.then(
                () => {
                  if (settled) {
                    return
                  }
                  waitingForConsumer = false
                  if (stream.pauseTimeoutWhileConsuming) {
                    armTimeout()
                  }
                  const rest = chunk.slice(cursor)
                  if (rest) {
                    receive(rest)
                  }
                  if (!waitingForConsumer && !settled) {
                    socket.resume()
                  }
                },
                () =>
                  finish({
                    ok: false,
                    error: new RuntimeClientError(
                      'invalid_runtime_response',
                      'Runtime stream consumer failed'
                    )
                  })
              )
              return
            }
          } catch {
            finish({
              ok: false,
              error: new RuntimeClientError(
                'invalid_runtime_response',
                'Invalid runtime stream payload'
              )
            })
            return
          }
          timeout?.refresh()
          continue
        }
        finish({ ok: true, response })
        return
      }
    }
    socket.on('data', receive)
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({
          id: requestId,
          authToken: metadata.authToken,
          method,
          params,
          orchestrationCapability: envelope?.orchestrationCapability,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId,
          compatibilityInvocationId: envelope?.compatibilityInvocationId,
          orchestrationCompatibilityEvidence: envelope?.orchestrationCompatibilityEvidence,
          expectedRuntimeSource
        })}\n`
      )
    })
    if (stream?.signal?.aborted) {
      abort()
    } else {
      stream?.signal?.addEventListener('abort', abort, { once: true })
    }
  })
}
