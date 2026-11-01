// The private listener forwards only to the same user's loopback gateway.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { request } from 'node:http'

const server = createServer({
  key: readFileSync('/etc/opka-push/loopback-server.key'),
  cert: readFileSync('/etc/opka-push/loopback-server.crt'),
  minVersion: 'TLSv1.2',
  maxHeaderSize: 16384
}, (incoming, outgoing) => {
  const upstream = request({ hostname: '127.0.0.1', port: 18088,
    path: incoming.url, method: incoming.method, headers: incoming.headers,
    timeout: 15000 }, (reply) => {
    outgoing.writeHead(reply.statusCode ?? 502, reply.headers)
    reply.pipe(outgoing)
  })
  upstream.on('timeout', () => upstream.destroy())
  upstream.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502)
    outgoing.end()
  })
  incoming.on('aborted', () => upstream.destroy())
  outgoing.on('close', () => upstream.destroy())
  incoming.pipe(upstream)
})
server.requestTimeout = 20000
server.headersTimeout = 10000
server.listen(18443, '127.0.0.1')
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    server.close()
    setTimeout(() => process.exit(), 5000).unref()
  })
}
