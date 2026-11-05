import type { Server } from 'node:http'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'

/** Socket closure is followed by owned asynchronous transport cleanup, never process retirement. */
export async function shutdownClaudeNativeGateway(
  server: Server,
  revoked: AbortController,
  cleanups: ReadonlySet<Promise<void>>
) {
  revoked.abort()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  try {
    if (cleanups.size) {
      await waitForPromiseWithSignal(Promise.allSettled(cleanups), AbortSignal.timeout(1000))
    }
  } catch {
    throw new Error('Native gateway cleanup remains unverifiable.')
  }
}
