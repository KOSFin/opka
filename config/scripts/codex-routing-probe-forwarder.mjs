import { createServer, request } from 'node:http'
import { pipeline } from 'node:stream/promises'

export async function startSyntheticAccountForwarder(base) {
  let selected = 'A'
  const inFlight = new Set()
  const server = createServer(async (incoming, outgoing) => {
    let upstream
    const cancel = () => upstream?.destroy()
    outgoing.once('close', cancel)
    try {
      if (incoming.headers.authorization !== 'Bearer synthetic-no-real-account') {
        outgoing.writeHead(401).end()
        return
      }
      let body = ''
      for await (const chunk of incoming) {
        body += chunk
        if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
          throw new Error('Synthetic forwarder body limit')
        }
      }
      const payload = JSON.parse(body)
      payload.model = `opka-${selected}/${payload.model}`
      const bytes = JSON.stringify(payload)
      upstream = request(`${base}${incoming.url}`, {
        method: incoming.method,
        headers: {
          authorization: 'Bearer synthetic-no-real-account',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bytes)
        }
      })
      inFlight.add(upstream)
      const response = await new Promise((resolve, reject) => {
        upstream.once('response', resolve)
        upstream.once('error', reject)
        upstream.end(bytes)
      })
      outgoing.writeHead(response.statusCode, {
        'content-type': response.headers['content-type'] ?? 'application/json',
        'cache-control': 'no-store'
      })
      await pipeline(response, outgoing)
    } catch {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502).end()
      } else {
        outgoing.destroy()
      }
    } finally {
      outgoing.off('close', cancel)
      upstream?.destroy()
      inFlight.delete(upstream)
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    switchToB: () => {
      selected = 'B'
    },
    async stop() {
      for (const pending of inFlight) {
        pending.destroy()
      }
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    }
  }
}
