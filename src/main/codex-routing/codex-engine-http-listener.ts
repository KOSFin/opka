import type { Server } from 'node:http'
import {
  createCodexRoutingHttpServer,
  type CodexRoutingHttpOptions
} from './codex-routing-http-server'

export class CodexEngineHttpListener {
  private server: Server | undefined
  url: string | undefined
  constructor(
    private readonly maxRequestBytes: number,
    private readonly prepare: CodexRoutingHttpOptions['prepare'],
    private readonly onCleanup: () => void,
    private readonly readNativeClientKey?: () => string
  ) {}
  async listen(): Promise<void> {
    if (this.server) {
      return
    }
    const server = createCodexRoutingHttpServer({
      maxConcurrent: 8,
      nativeClientKey: this.readNativeClientKey?.(),
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: 32 * 1024 * 1024,
      responseHeaderTimeoutMs: 120000,
      prepare: this.prepare,
      onCleanupUnverifiable: this.onCleanup
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
