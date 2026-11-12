import type { Server } from 'node:http'
import { CODEX_ROUTING_RESPONSE_HEADER_TIMEOUT_MS } from './codex-routing-http-types'
import {
  createCodexRoutingHttpServer,
  type CodexRoutingHttpOptions
} from './codex-routing-http-server'
import type { CodexReplaySpoolBudget } from './codex-replay-spool'

export class CodexEngineHttpListener {
  private server: Server | undefined
  url: string | undefined
  constructor(
    private readonly maxRequestBytes: number,
    private readonly prepare: CodexRoutingHttpOptions['prepare'],
    private readonly onCleanup: () => void,
    private readonly readNativeClientKey?: () => string,
    private readonly replayBudget?: CodexReplaySpoolBudget,
    private readonly onRequestHeld?: () => void,
    private readonly waitForReady?: CodexRoutingHttpOptions['waitForReady'],
    private readonly onClientInterrupted?: () => void
  ) {}
  async listen(): Promise<void> {
    if (this.server) {
      return
    }
    const server = createCodexRoutingHttpServer({
      maxConcurrent: 4,
      nativeClientKey: this.readNativeClientKey?.(),
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: 32 * 1024 * 1024,
      responseHeaderTimeoutMs: CODEX_ROUTING_RESPONSE_HEADER_TIMEOUT_MS,
      prepare: this.prepare,
      onCleanupUnverifiable: this.onCleanup,
      replayBudget: this.replayBudget,
      onRequestHeld: this.onRequestHeld,
      waitForReady: this.waitForReady,
      onClientInterrupted: this.onClientInterrupted
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
    } catch (error) {
      server.close(() => {})
      throw error
    }
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('Routing listener is unavailable.')
    }
    this.server = server
    this.url = `http://127.0.0.1:${address.port}/v1`
  }
  cancelRequests(): void {
    this.server?.closeAllConnections()
  }
  async close(): Promise<void> {
    if (!this.server) {
      return
    }
    const server = this.server
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    server.closeAllConnections()
    await closed
    this.server = undefined
    this.url = undefined
  }
}
