import { request, type OutgoingHttpHeaders } from 'node:http'
import {
  openClaudeNativeGatewayUpstream,
  type ClaudeNativeGatewayUpstream
} from './claude-native-gateway-upstream'

/** Production egress always uses the existing host client; only isolated fixtures use HTTP. */
export function openClaudeNativeGatewayExchange(options: {
  target: URL
  path: string
  headers: OutgoingHttpHeaders
  body: Buffer
  signal: AbortSignal
  beforeSend: () => void
  timeoutMs: number
}): Promise<ClaudeNativeGatewayUpstream> {
  if (options.target.protocol === 'https:') {
    return openClaudeNativeGatewayUpstream(options)
  }
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        protocol: 'http:',
        hostname: options.target.hostname,
        port: options.target.port,
        path: options.path,
        method: 'POST',
        agent: false,
        signal: options.signal,
        headers: options.headers,
        timeout: options.timeoutMs
      },
      (response) => {
        let closing: Promise<void> | undefined
        resolve(
          Object.assign(response, {
            statusCode: response.statusCode ?? 502,
            closeBody: () =>
              (closing ??= new Promise<void>((done) => {
                if (response.closed) {
                  done()
                  return
                }
                response.once('close', done)
                response.destroy()
                outgoing.destroy()
              }))
          })
        )
      }
    )
    outgoing.on('timeout', () =>
      outgoing.destroy(new Error('Native fixture upstream idle deadline.'))
    )
    outgoing.once('error', reject)
    try {
      options.beforeSend()
      outgoing.end(options.body)
    } catch (error) {
      outgoing.destroy()
      reject(error)
    }
  })
}
