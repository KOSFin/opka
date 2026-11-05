import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, connect } from 'node:net'
import { once } from 'node:events'
import { createNativeRefreshConnectProxy } from './claude-native-refresh-connect-proxy.mjs'

async function fixture(run) {
  const peers = new Set()
  const upstream = createServer((socket) => {
    peers.add(socket)
    socket.once('close', () => peers.delete(socket))
    socket.on('error', () => {})
    socket.on('data', (data) => socket.write(data))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const proxy = await createNativeRefreshConnectProxy(upstream.address().port)
  try {
    await run(proxy, peers)
  } finally {
    await proxy.close()
    for (const peer of peers) {
      peer.destroy()
    }
    await new Promise((resolve) => upstream.close(resolve))
  }
}
async function request(proxy, text) {
  const client = connect({ host: '127.0.0.1', port: Number(new URL(proxy.url).port) })
  await once(client, 'connect')
  client.write(text)
  const [reply] = await once(client, 'data')
  return { client, reply: reply.toString() }
}
test('CONNECT relays only the approved hostname to the private loopback fixture', async () => {
  await fixture(async (proxy) => {
    const { client, reply } = await request(
      proxy,
      'CONNECT platform.claude.com:443 HTTP/1.1\r\nHost: platform.claude.com:443\r\n\r\n'
    )
    assert.match(reply, /200 Connection Established/)
    client.write('synthetic-opaque-tls-bytes')
    assert.equal((await once(client, 'data'))[0].toString(), 'synthetic-opaque-tls-bytes')
    client.destroy()
    assert.equal(proxy.counts.accepted, 1)
  })
})
test('unknown destinations, HTTP requests and noncanonical CONNECT targets never connect upstream', async () => {
  await fixture(async (proxy, peers) => {
    for (const line of [
      'CONNECT example.invalid:443',
      'CONNECT platform.claude.com:444',
      'CONNECT claude.fedstart.com:443',
      'GET http://platform.claude.com/'
    ]) {
      const { client, reply } = await request(
        proxy,
        `${line} HTTP/1.1\r\nHost: example.invalid\r\n\r\n`
      )
      assert.match(reply, /403/)
      client.destroy()
    }
    assert.equal(proxy.counts.accepted, 0)
    assert.equal(proxy.counts.rejected, 4)
    assert.equal(peers.size, 0)
  })
})
test('shutdown destroys an accepted open tunnel and proves listener/socket closure', async () => {
  await fixture(async (proxy) => {
    const { client } = await request(
      proxy,
      'CONNECT platform.claude.com:443 HTTP/1.1\r\nHost: platform.claude.com:443\r\n\r\n'
    )
    const exited = once(client, 'close')
    assert.deepEqual(await proxy.close(), { sockets: 0, listenerClosed: true })
    await exited
  })
})
test('invalid local fixture ports are refused before opening a listener', async () => {
  for (const port of [0, -1, 65536, '443']) {
    await assert.rejects(createNativeRefreshConnectProxy(port), /fixture port/)
  }
})
test('one fixture accepts at most 32 CONNECT tunnels', async () => {
  await fixture(async (proxy) => {
    for (let index = 0; index < 33; index++) {
      const { client, reply } = await request(
        proxy,
        'CONNECT platform.claude.com:443 HTTP/1.1\r\nHost: platform.claude.com:443\r\n\r\n'
      )
      assert.match(reply, index < 32 ? /200/ : /403/)
      const ended = once(client, 'close')
      client.destroy()
      await ended
    }
    assert.equal(proxy.counts.accepted, 32)
    assert.equal(proxy.counts.rejected, 1)
  })
})
test('native default API hostname reaches only the same loopback fixture', async () => {
  await fixture(async (proxy) => {
    const { client, reply } = await request(
      proxy,
      'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n'
    )
    assert.match(reply, /200 Connection Established/)
    client.destroy()
    assert.equal(proxy.counts.accepted, 1)
  })
})
