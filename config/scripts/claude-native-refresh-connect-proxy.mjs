import { createServer } from 'node:http'
import { connect } from 'node:net'

/** Only the fake OAuth hostname can reach the fixture's loopback TLS listener. */
export async function createNativeRefreshConnectProxy(tlsPort) {
  if (!Number.isInteger(tlsPort) || tlsPort < 1 || tlsPort > 65535) {
    throw new Error('A loopback TLS fixture port is required')
  }
  const sockets = new Set()
  const counts = { accepted: 0, rejected: 0, bytes: 0 }
  let closing = false
  let closePromise
  const track = (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    return socket
  }
  const server = createServer({ maxHeaderSize: 2048 }, (_request, response) => {
    counts.rejected++
    response.writeHead(403, { connection: 'close' }).end()
  })
  server.headersTimeout = 2000
  server.requestTimeout = 5000
  server.maxConnections = 8
  server.on('connection', (socket) => {
    track(socket)
    socket.setTimeout(5000, () => socket.destroy())
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('connect', (request, client, head) => {
    if (
      closing ||
      request.url !== 'claude.fedstart.com:443' ||
      head.length !== 0 ||
      counts.accepted >= 32 ||
      sockets.size >= 8 ||
      counts.bytes >= 8 * 1024 * 1024
    ) {
      counts.rejected++
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    counts.accepted++
    const upstream = track(connect({ host: '127.0.0.1', port: tlsPort }))
    const deadline = setTimeout(() => {
      client.destroy()
      upstream.destroy()
    }, 60000)
    const teardown = () => {
      clearTimeout(deadline)
      client.destroy()
      upstream.destroy()
    }
    client.once('close', teardown)
    upstream.once('close', teardown)
    upstream.setTimeout(2000, teardown)
    upstream.once('connect', () => {
      upstream.setTimeout(10000, teardown)
      client.setTimeout(10000, teardown)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const debit = (chunk) => {
        counts.bytes += chunk.length
        if (counts.bytes > 8 * 1024 * 1024) {
          teardown()
        }
      }
      client.on('data', debit)
      upstream.on('data', debit)
      client.pipe(upstream)
      upstream.pipe(client)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address !== 'object') {
    throw new Error('Missing private CONNECT listener')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    counts,
    close() {
      if (closePromise) {
        return closePromise
      }
      closing = true
      closePromise = (async () => {
        let timer
        try {
          const closedSockets = [...sockets].map((socket) =>
            socket.closed
              ? Promise.resolve()
              : new Promise((resolve) => socket.once('close', resolve))
          )
          const listener = new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
          for (const socket of sockets) {
            socket.destroy()
          }
          await Promise.race([
            Promise.all([listener, ...closedSockets]),
            new Promise((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error('CONNECT cleanup remains unverifiable')),
                2000
              )
            })
          ])
          if (sockets.size !== 0) {
            throw new Error('CONNECT sockets remain live')
          }
          return { sockets: sockets.size, listenerClosed: !server.listening }
        } finally {
          clearTimeout(timer)
        }
      })()
      return closePromise
    }
  }
}
