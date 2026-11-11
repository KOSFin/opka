import { createServer, request, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createCodexRoutingHttpServer,
  type CodexHttpAccountRoute
} from './codex-routing-http-server'
import { codexRoutingHeaders } from './codex-routing-http-headers'

const token = 'synthetic-local-session-key-12345678'
const engineKey = 'synthetic-engine-key-1234567890123456'
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections()
          server.close(() => done())
        })
    )
  )
})
async function listen(server: Server) {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing test listener')
  }
  return { port: address.port, url: `http://127.0.0.1:${address.port}` }
}
async function fixture(
  options: {
    headerDeadline?: number
    finishThrows?: boolean
    maxRequestBytes?: number
    maxConcurrent?: number
  } = {}
) {
  const seen: { path?: string; authorization?: string; turn?: string; body: unknown }[] = []
  const engine = await listen(
    createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      seen.push({
        path: req.url,
        authorization: req.headers.authorization,
        turn: String(req.headers['x-codex-turn-metadata']),
        body
      })
      if (body.model.endsWith('/large')) {
        res.writeHead(200)
        res.end('x'.repeat(5000))
        return
      }
      if (body.model.endsWith('/later-large')) {
        res.writeHead(200)
        res.write('x'.repeat(2000))
        setImmediate(() => res.end('y'.repeat(3000)))
        return
      }
      if (body.model.endsWith('/hang')) {
        return
      }
      if (body.model.endsWith('/partial')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: response.created\ndata: {}\n\n')
        return
      }
      const status = body.model.endsWith('/denied') ? 403 : 200
      res.writeHead(status, {
        'content-type': 'application/json',
        'x-codex-routing-hint': 'account-specific',
        'set-cookie': 'must-not-leave-engine'
      })
      res.end(JSON.stringify({ result: body.model, marker: 'é🔧' }))
    })
  )
  const finish = vi.fn(() => {
    if (options.finishThrows) {
      throw new Error('synthetic cleanup failure')
    }
  })
  const cleanup = vi.fn()
  const prepare = vi.fn((_token: string, _input: unknown) => ({
    port: engine.port,
    clientKey: engineKey,
    prefix: 'account-b',
    finish
  }))
  const front = createCodexRoutingHttpServer({
    maxConcurrent: options.maxConcurrent ?? 1,
    maxRequestBytes: options.maxRequestBytes ?? 4096,
    maxResponseBytes: 4096,
    responseHeaderTimeoutMs: options.headerDeadline ?? 1000,
    onCleanupUnverifiable: cleanup,
    prepare
  })
  const listener = await listen(front)
  const post = (body: string, path = '/v1/responses', headers: Record<string, string> = {}) =>
    fetch(`${listener.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...headers },
      body
    })
  return { seen, front, listener, finish, cleanup, prepare, post }
}

it('preserves native model options, tools, Unicode and turn metadata while selecting an exact account prefix', async () => {
  const { post, seen, prepare, finish } = await fixture()
  const payload = {
    model: 'native-model',
    input: [{ role: 'user', content: 'é🔧' }],
    tools: [{ type: 'function', name: 'mcp__demo__lookup', parameters: { type: 'object' } }],
    reasoning: { effort: 'xhigh', summary: 'auto' },
    parallel_tool_calls: false
  }
  const turn = JSON.stringify({ thread_id: 'thread', turn_id: '0' })
  const response = await post(JSON.stringify(payload), '/v1/responses', {
    'x-codex-turn-metadata': turn
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ result: 'account-b/native-model', marker: 'é🔧' })
  expect(seen).toEqual([
    {
      path: '/v1/responses',
      authorization: `Bearer ${engineKey}`,
      turn,
      body: { ...payload, model: 'account-b/native-model' }
    }
  ])
  expect(prepare).toHaveBeenCalledWith(token, {
    model: 'native-model',
    compact: false,
    turn: { threadId: 'thread', turnId: '0' }
  })
  expect(response.headers.has('set-cookie')).toBe(false)
  expect(response.headers.has('x-codex-routing-hint')).toBe(false)
  await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
})

it('passes provider denial once, forwards compact requests, and never retries inference', async () => {
  const { post, seen, finish } = await fixture()
  expect((await post('{"model":"denied"}')).status).toBe(403)
  const response = await post('{"model":"native-model","input":[]}', '/v1/responses/compact')
  expect(response.status).toBe(200)
  await response.text()
  expect(seen.map((entry) => entry.path)).toEqual(['/v1/responses', '/v1/responses/compact'])
  await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(2))
})

it('does not release an account lease merely because its local client disconnected', async () => {
  let received: () => void = () => {}
  const upstreamReceived = new Promise<void>((resolve) => {
    received = resolve
  })
  let localSocketClosed: () => void = () => {}
  const socketClosed = new Promise<void>((resolve) => {
    localSocketClosed = resolve
  })
  const engine = await listen(
    createServer(async (req) => {
      req.socket.once('close', localSocketClosed)
      for await (const _chunk of req) {
        // The synthetic provider operation stays live beyond the local socket.
      }
      received()
    })
  )
  const finish = vi.fn()
  const holdUntilOwnerExit = vi.fn(() => new Promise<void>(() => {}))
  const front = await listen(
    createCodexRoutingHttpServer({
      maxConcurrent: 1,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      responseHeaderTimeoutMs: 1000,
      onCleanupUnverifiable: vi.fn(),
      prepare: () => ({
        port: engine.port,
        clientKey: engineKey,
        prefix: 'a',
        finish,
        holdUntilOwnerExit
      })
    })
  )
  const controller = new AbortController()
  const response = fetch(`${front.url}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: '{"model":"native"}',
    signal: controller.signal
  }).catch(() => {})
  await upstreamReceived
  controller.abort()
  await response
  await socketClosed
  await vi.waitFor(() => expect(holdUntilOwnerExit).toHaveBeenCalledOnce())
  expect(finish).not.toHaveBeenCalled()
})

it('refuses malformed, oversized, compressed and response-id-only requests before acquiring a route', async () => {
  const { post, prepare } = await fixture()
  for (const [body, status] of [
    ['invalid', 400],
    ['{"input":[]}', 400],
    [`{"model":"m","padding":"${'x'.repeat(5000)}"}`, 413],
    ['{"model":"m","previous_response_id":"account-a-response"}', 409]
  ] as const) {
    expect((await post(body)).status).toBe(status)
  }
  expect(
    (await post('{"model":"m"}', '/v1/responses', { 'content-encoding': 'gzip' })).status
  ).toBe(415)
  expect(prepare).not.toHaveBeenCalled()
})

it('forwards an image-bearing full history above the old limit through Responses and compact', async () => {
  const { post, seen, finish } = await fixture({
    maxRequestBytes: 16 * 1024 * 1024,
    maxConcurrent: 4
  })
  const image = `data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}`
  const payload = {
    model: 'native-model',
    input: [
      { type: 'function_call', call_id: 'earlier-tool', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'earlier-tool', output: 'retained-history' },
      { role: 'user', content: [{ type: 'input_image', image_url: image }] }
    ],
    reasoning: { effort: 'medium' }
  }
  const raw = JSON.stringify(payload)
  expect(Buffer.byteLength(raw)).toBeGreaterThan(11.4 * 1024 * 1024)
  for (const path of ['/v1/responses', '/v1/responses/compact']) {
    const response = await post(raw, path)
    expect(response.status).toBe(200)
    await response.text()
  }
  const expectedLength = Buffer.byteLength(
    JSON.stringify({ ...payload, model: 'account-b/native-model' })
  )
  expect(seen.map((entry) => Buffer.byteLength(JSON.stringify(entry.body)))).toEqual([
    expectedLength,
    expectedLength
  ])
  expect(seen.map((entry) => entry.path)).toEqual(['/v1/responses', '/v1/responses/compact'])
  expect(JSON.stringify(seen[1]?.body)).toContain('retained-history')
  await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(2))
})

it('keeps the rewritten body within the engine cap and refuses oversize without forwarding', async () => {
  const maxRequestBytes = 16 * 1024 * 1024
  const { post, seen, prepare, finish } = await fixture({ maxRequestBytes, maxConcurrent: 4 })
  const start = '{"model":"native-model","input":"'
  const end = '"}'
  const body = (bytes: number) => start + 'A'.repeat(bytes - start.length - end.length) + end
  const accepted = await post(body(maxRequestBytes - 64))
  expect(accepted.status).toBe(200)
  await accepted.text()
  expect(seen).toHaveLength(1)
  const rewrittenTooLarge = await post(body(maxRequestBytes - 1))
  expect(rewrittenTooLarge.status).toBe(413)
  expect(await rewrittenTooLarge.text()).toContain('forwarded request byte budget')
  expect(seen).toHaveLength(1)
  const incomingTooLarge = await post(body(maxRequestBytes + 1))
  expect(incomingTooLarge.status).toBe(413)
  expect(await incomingTooLarge.text()).toContain('local request byte budget')
  expect(seen).toHaveLength(1)
  expect(prepare).toHaveBeenCalledTimes(2)
  await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(2))
})

it('admits four small streams but rejects a fifth until a stream closes', async () => {
  const { post, seen, finish } = await fixture({
    maxRequestBytes: 16 * 1024 * 1024,
    maxConcurrent: 4
  })
  const streams = await Promise.all(Array.from({ length: 4 }, () => post('{"model":"partial"}')))
  expect(streams.map((response) => response.status)).toEqual([200, 200, 200, 200])
  expect((await post('{"model":"native-model"}')).status).toBe(429)
  expect(seen).toHaveLength(4)
  await streams[0].body?.cancel()
  await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
  const next = await post('{"model":"native-model"}')
  expect(next.status).toBe(200)
  await next.text()
  await Promise.all(streams.slice(1).map((response) => response.body?.cancel()))
})

it('cancels an accepted stream and frees the request budget without a replay', async () => {
  const { post, seen, finish } = await fixture()
  const response = await post('{"model":"partial"}')
  expect((await post('{"model":"native-model"}')).status).toBe(429)
  await response.body?.cancel()
  await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
  expect(seen).toHaveLength(1)
  const next = await post('{"model":"native-model"}')
  expect(next.status).toBe(200)
  await next.text()
})

it('ends header waits within a fixed budget and still releases the prepared route', async () => {
  const { post, finish } = await fixture({ headerDeadline: 100 })
  const failed = await post('{"model":"hang"}')
  expect(failed.status).toBe(502)
  expect(await failed.text()).toContain('engine-headers/HEADER_DEADLINE')
  await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
  const next = await post('{"model":"native-model"}')
  expect(next.status).toBe(200)
  await next.text()
})

it('bounds response bytes and frees the route after terminating an oversized stream', async () => {
  const { post, finish } = await fixture()
  await expect(
    (async () => {
      const response = await post('{"model":"large"}')
      await response.text()
    })()
  ).rejects.toThrow()
  await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
  const next = await post('{"model":"native-model"}')
  expect(next.status).toBe(200)
  await next.text()
})

it('marks a later-chunk overflow incomplete and keeps normal framing explicit', async () => {
  const { post } = await fixture()
  const normal = await post('{"model":"native-model"}')
  expect(normal.headers.get('transfer-encoding')).toBe('chunked')
  expect(normal.headers.has('content-length')).toBe(false)
  await normal.text()
  await expect(
    (async () => {
      const overflow = await post('{"model":"later-large"}')
      await overflow.text()
    })()
  ).rejects.toThrow()
  await expect(
    (async () => {
      const compact = await post('{"model":"large"}', '/v1/responses/compact')
      await compact.text()
    })()
  ).rejects.toThrow()
})

it.each([204, 304])('does not add body framing to an engine %s response', async (status) => {
  const engine = await listen(
    createServer(async (req, res) => {
      for await (const _chunk of req) {
        // Consume the synthetic request before issuing a bodyless response.
      }
      res.writeHead(status)
      res.end()
    })
  )
  const finish = vi.fn()
  const front = await listen(
    createCodexRoutingHttpServer({
      maxConcurrent: 1,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      responseHeaderTimeoutMs: 1000,
      onCleanupUnverifiable: vi.fn(),
      prepare: () => ({ port: engine.port, clientKey: engineKey, prefix: 'a', finish })
    })
  )
  const response = await fetch(`${front.url}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: '{"model":"native"}'
  })
  expect(response.status).toBe(status)
  expect(response.headers.has('transfer-encoding')).toBe(false)
  await response.text()
  await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce())
})

it('refuses missing authentication without sending a provider request', async () => {
  const { post, prepare, seen } = await fixture()
  expect(
    (await post('{"model":"native-model"}', '/v1/responses', { authorization: '' })).status
  ).toBe(401)
  expect(prepare).not.toHaveBeenCalled()
  expect(seen).toHaveLength(0)
})

it('keeps the host serving when route cleanup cannot be confirmed', async () => {
  const { post, cleanup } = await fixture({ finishThrows: true })
  const first = await post('{"model":"native-model"}')
  await first.text()
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
  const next = await post('{"model":"native-model"}')
  expect(next.status).toBe(200)
  await next.text()
})

it('rejects WebSocket upgrades instead of exposing an unqualified transport', async () => {
  const { listener, prepare } = await fixture()
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      `${listener.url}/v1/responses`,
      { headers: { connection: 'Upgrade', upgrade: 'websocket' } },
      (response) => {
        response.resume()
        resolve(response.statusCode)
      }
    )
    req.once('error', reject)
    req.end()
  })
  expect(status).toBe(426)
  expect(prepare).not.toHaveBeenCalled()
})

it('removes dynamic hop headers and old account hints while keeping native feature headers', () => {
  expect(
    codexRoutingHeaders({
      connection: 'x-private-hop',
      'x-private-hop': 'do-not-forward',
      authorization: 'old',
      'chatgpt-account-id': 'old-account',
      'x-codex-turn-state': 'old-state',
      'openai-beta': 'native-feature',
      'user-agent': 'native-cli'
    })
  ).toEqual({
    'openai-beta': 'native-feature',
    'user-agent': 'native-cli'
  })
})

it('retries only the current complete quota rejection with all native history, model and tool fields intact', async () => {
  const bodies: Record<string, unknown>[] = []
  const engine = await listen(
    createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      bodies.push(body)
      res.writeHead(body.model.startsWith('a/') ? 429 : 200, { 'content-type': 'application/json' })
      res.end(
        body.model.startsWith('a/')
          ? JSON.stringify({ error: { code: 'usage_limit_reached' } })
          : '{"ok":true}'
      )
    })
  )
  const finish = vi.fn()
  const retry = vi.fn(() => ({
    port: engine.port,
    clientKey: engineKey,
    prefix: 'b',
    accountId: 'b',
    quotaIdentity: 'b',
    finish
  }))
  const front = await listen(
    createCodexRoutingHttpServer({
      maxConcurrent: 1,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      responseHeaderTimeoutMs: 1000,
      onCleanupUnverifiable: vi.fn(),
      prepare: () => ({
        port: engine.port,
        clientKey: engineKey,
        prefix: 'a',
        accountId: 'a',
        quotaIdentity: 'a',
        finish,
        retryRejectedQuota: retry
      })
    })
  )
  const body = {
    model: 'native',
    input: [
      { type: 'function_call', call_id: 'tool-1', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'tool-1', output: 'retained' }
    ],
    tools: [{ type: 'function', name: 'lookup' }],
    reasoning: { effort: 'high' },
    parallel_tool_calls: false
  }
  const response = await fetch(`${front.url}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
  expect(bodies).toEqual([
    { ...body, model: 'a/native' },
    { ...body, model: 'b/native' }
  ])
  expect(retry).toHaveBeenCalledOnce()
  expect(retry.mock.calls[0]).toEqual([
    { kind: 'quota', code: 'usage_limit_reached' },
    expect.objectContaining({ allowRetry: true, signal: expect.any(AbortSignal) })
  ])
  expect(finish).toHaveBeenCalledOnce()
})

it.each([
  [403, 'application/json', '{"error":{"code":"usage_limit_reached"}}'],
  [429, 'application/json', '{"error":{"code":"rate_limit_exceeded"}}'],
  [429, 'application/json', '{"error":'],
  [429, 'text/event-stream', 'data: {"error":{"code":"usage_limit_reached"}}\n\n'],
  [401, 'application/json', '{"error":{"code":"token_expired"}}'],
  [429, 'application/json', 'x'.repeat(17000)]
] as const)(
  'does not retry unconfirmed, authentication or oversized errors (%s %s)',
  async (status, type, text) => {
    const engine = await listen(
      createServer((_req, res) => {
        res.writeHead(status, { 'content-type': type })
        res.end(text)
      })
    )
    const retry = vi.fn()
    const front = await listen(
      createCodexRoutingHttpServer({
        maxConcurrent: 1,
        maxRequestBytes: 4096,
        maxResponseBytes: 20000,
        responseHeaderTimeoutMs: 1000,
        onCleanupUnverifiable: vi.fn(),
        prepare: () => ({
          port: engine.port,
          clientKey: engineKey,
          prefix: 'a',
          quotaIdentity: 'a',
          finish: vi.fn(),
          retryRejectedQuota: retry
        })
      })
    )
    const response = await fetch(`${front.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '{"model":"native"}'
    })
    expect(response.status).toBe(status)
    expect(await response.text()).toBe(text)
    expect(retry).not.toHaveBeenCalled()
  }
)

it('bounds a rejected native request to sixteen distinct identities and stamps the final refusal', async () => {
  let requests = 0
  const engine = await listen(
    createServer((_req, res) => {
      requests++
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"error":{"code":"usage_limit_reached"}}')
    })
  )
  const finish = vi.fn()
  let index = 0
  const retry = vi.fn(
    (_failure: unknown, context: { allowRetry: boolean }): CodexHttpAccountRoute | null =>
      context.allowRetry ? route(++index) : null
  )
  function route(id: number): CodexHttpAccountRoute {
    return {
      port: engine.port,
      clientKey: engineKey,
      prefix: `a${id}`,
      quotaIdentity: `q${id}`,
      finish,
      retryRejectedQuota: retry
    }
  }
  const front = await listen(
    createCodexRoutingHttpServer({
      maxConcurrent: 1,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      responseHeaderTimeoutMs: 1000,
      onCleanupUnverifiable: vi.fn(),
      prepare: () => route(0)
    })
  )
  const response = await fetch(`${front.url}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: '{"model":"native"}'
  })
  expect(response.status).toBe(429)
  await response.text()
  expect(requests).toBe(16)
  expect(retry).toHaveBeenCalledTimes(16)
  expect(retry.mock.calls[15][1]).toMatchObject({ allowRetry: false })
  expect(finish).toHaveBeenCalledOnce()
})
