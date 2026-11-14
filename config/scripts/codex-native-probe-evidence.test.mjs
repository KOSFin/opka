import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout } from 'node:timers/promises'
import { test } from 'vitest'
import { captureNativeProbeRequests } from './codex-native-probe-evidence.mjs'

test('wire observation preserves a small body while the production reader awaits disk', async () => {
  const payload = JSON.stringify({ model: 'synthetic', input: [], stream: true })
  let received = ''
  const server = createServer(async (request, response) => {
    await setTimeout(25)
    for await (const bytes of request) {
      received += bytes.toString()
    }
    response.end('ok')
  })
  const report = {}
  captureNativeProbeRequests(server, report)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const result = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: 'POST',
      body: payload,
      signal: AbortSignal.timeout(2000)
    })
    assert.equal(await result.text(), 'ok')
    assert.equal(received, payload)
    assert.equal(report.nativeWireEvidence[0].bytes, Buffer.byteLength(payload))
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
