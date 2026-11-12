import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { createCodexRoutingHttpServer } from './codex-routing-http-server'
import { CodexReplaySpoolBudget } from './codex-replay-spool'

const token = 'synthetic-replay-session-1234567890123456'
const engineKey = 'synthetic-replay-engine-1234567890123456'
const servers: Server[] = []
const directories: string[] = []

async function listen(server: Server): Promise<string> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Synthetic listener is unavailable.')
  }
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

it('decodes a compressed native request beyond the legacy body budget before replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-native-zstd-'))
  directories.push(directory)
  const replayBudget = new CodexReplaySpoolBudget(directory, 512 * 1024 * 1024, () => {})
  const content = 'A'.repeat(17 * 1024 * 1024)
  const plain = `{"model":"native","stream":true,"input":[{"content":"${content}"}]}`
  const compressed = zstdCompressSync(Buffer.from(plain))
  const seen = createHash('sha256')
  let bytes = 0
  const engine = await listen(
    createServer(async (req, res) => {
      expect(req.headers['content-encoding']).toBeUndefined()
      for await (const chunk of req) {
        seen.update(chunk)
        bytes += chunk.length
      }
      res.writeHead(400, {
        'content-type': 'application/json',
        trailer: 'x-orca-provider-terminal-v1'
      })
      res.addTrailers({ 'x-orca-provider-terminal-v1': '1' })
      res.end('{"error":"synthetic upstream"}')
    })
  )
  const finish = vi.fn()
  const front = await listen(
    createCodexRoutingHttpServer({
      maxConcurrent: 4,
      maxRequestBytes: 16 * 1024 * 1024,
      maxResponseBytes: 4096,
      responseHeaderTimeoutMs: 1000,
      onCleanupUnverifiable: vi.fn(),
      replayBudget,
      prepare: () => ({
        port: Number(new URL(engine).port),
        clientKey: engineKey,
        prefix: 'a',
        finish,
        holdUntilOwnerExit: async () => {}
      })
    })
  )
  const response = await fetch(`${front}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-encoding': 'zstd' },
    body: compressed
  })
  expect(response.status).toBe(400)
  await response.text()
  const expected = createHash('sha256')
  expected.update(`{"model":"a/native","stream":true,"input":[{"content":"${content}"}]}`)
  expect(seen.digest('hex')).toBe(expected.digest('hex'))
  expect(bytes).toBe(Buffer.byteLength(plain) + 2)
  await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce())
  expect(replayBudget.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
  expect(await readdir(directory)).toEqual([])
}, 120_000)

it('rejects invalid compressed ingress before provider traffic and releases the spool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-native-bad-zstd-'))
  directories.push(directory)
  const replayBudget = new CodexReplaySpoolBudget(directory, 512 * 1024 * 1024, () => {})
  const engineCalls = vi.fn()
  const engine = await listen(
    createServer((_req, res) => {
      engineCalls()
      res.end('{}')
    })
  )
  const front = await listen(
    createCodexRoutingHttpServer({
      maxConcurrent: 4,
      maxRequestBytes: 16 * 1024 * 1024,
      maxResponseBytes: 4096,
      responseHeaderTimeoutMs: 1000,
      onCleanupUnverifiable: vi.fn(),
      replayBudget,
      prepare: () => ({
        port: Number(new URL(engine).port),
        clientKey: engineKey,
        prefix: 'a',
        finish: vi.fn(),
        holdUntilOwnerExit: async () => {}
      })
    })
  )
  const largeWindowFrame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x88, 0x01, 0x00, 0x00])
  expect(
    zstdDecompressSync(largeWindowFrame, {
      params: { [zlibConstants.ZSTD_d_windowLogMax]: 28 }
    })
  ).toEqual(Buffer.alloc(0))
  for (const body of [Buffer.from('invalid zstd'), largeWindowFrame]) {
    const response = await fetch(`${front}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-encoding': 'zstd' },
      body
    })
    expect(response.status).toBe(400)
  }
  expect(engineCalls).not.toHaveBeenCalled()
  expect(replayBudget.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
  expect(await readdir(directory)).toEqual([])
})

it('streams a 72 MiB request replay and a complete 72 MiB compact window with exact hashes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-native-replay-'))
  directories.push(directory)
  const replayBudget = new CodexReplaySpoolBudget(directory, 512 * 1024 * 1024, () => {})
  const image = Buffer.alloc(64 * 1024, 0x41)
  const requestHead = '{"model":"native","input":[{"content":"'
  const requestTail = '"}]}'
  const actualRequest = createHash('sha256')
  let requestBytes = 0
  const engine = await listen(
    createServer(async (req, res) => {
      for await (const chunk of req) {
        actualRequest.update(chunk)
        requestBytes += chunk.length
      }
      expect(req.headers.authorization).toBe(`Bearer ${engineKey}`)
      expect(req.url).toBe('/v1/responses/compact')
      res.writeHead(200, {
        'content-type': 'application/json',
        trailer: 'x-orca-provider-terminal-v1'
      })
      res.write('{"output":[{"type":"compaction","encrypted_content":"')
      for (let index = 0; index < 1152; index++) {
        if (!res.write(image)) {
          await once(res, 'drain')
        }
      }
      res.addTrailers({ 'x-orca-provider-terminal-v1': '1' })
      res.end('"},{"type":"message","content":"retained"}]}')
    })
  )
  const finish = vi.fn()
  const front = await listen(
    createCodexRoutingHttpServer({
      maxConcurrent: 4,
      maxRequestBytes: 16 * 1024 * 1024,
      maxResponseBytes: 4096,
      responseHeaderTimeoutMs: 120000,
      onCleanupUnverifiable: vi.fn(),
      replayBudget,
      prepare: () => ({
        port: Number(new URL(engine).port),
        clientKey: engineKey,
        prefix: 'a',
        finish,
        holdUntilOwnerExit: async () => {}
      })
    })
  )
  async function* requestBody() {
    yield requestHead
    for (let index = 0; index < 1152; index++) {
      yield image
    }
    yield requestTail
  }
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(
      `${front}/v1/responses/compact`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` }
      },
      resolve
    )
    outgoing.once('error', reject)
    void pipeline(Readable.from(requestBody()), outgoing).catch(reject)
  })
  expect(response.statusCode).toBe(200)
  const expectedRequest = createHash('sha256')
  expectedRequest.update('{"model":"a/native","input":[{"content":"')
  for (let index = 0; index < 1152; index++) {
    expectedRequest.update(image)
  }
  expectedRequest.update(requestTail)
  expect(actualRequest.digest('hex')).toBe(expectedRequest.digest('hex'))
  expect(requestBytes).toBe(
    1152 * image.length + Buffer.byteLength(requestHead) + Buffer.byteLength(requestTail) + 2
  )
  const actualResponse = createHash('sha256')
  for await (const chunk of response) {
    actualResponse.update(chunk)
  }
  const expectedResponse = createHash('sha256')
  expectedResponse.update('{"output":[{"type":"compaction","encrypted_content":"')
  for (let index = 0; index < 1152; index++) {
    expectedResponse.update(image)
  }
  expectedResponse.update('"},{"type":"message","content":"retained"}]}')
  expect(actualResponse.digest('hex')).toBe(expectedResponse.digest('hex'))
  await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce())
  expect(replayBudget.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
  expect(await readdir(directory)).toEqual([])
}, 120_000)

it('refuses an incomplete compact window before publishing success headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-native-compact-truncate-'))
  directories.push(directory)
  const replayBudget = new CodexReplaySpoolBudget(directory, 512 * 1024 * 1024, () => {})
  const engine = await listen(
    createServer(async (req, res) => {
      for await (const _chunk of req) {
        // The request is complete before the synthetic engine truncates its result.
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"output":[{"type":"compaction","encrypted_content":"truncated"}')
    })
  )
  const finish = vi.fn()
  const front = await listen(
    createCodexRoutingHttpServer({
      maxConcurrent: 4,
      maxRequestBytes: 16 * 1024 * 1024,
      maxResponseBytes: 4096,
      responseHeaderTimeoutMs: 1000,
      onCleanupUnverifiable: vi.fn(),
      replayBudget,
      prepare: () => ({
        port: Number(new URL(engine).port),
        clientKey: engineKey,
        prefix: 'a',
        finish,
        holdUntilOwnerExit: async () => {}
      })
    })
  )
  const response = await fetch(`${front}/v1/responses/compact`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: '{"model":"native","input":[]}'
  })
  expect(response.status).toBe(502)
  expect(await response.text()).toContain('engine-body')
  await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce())
  expect(replayBudget.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
  expect(await readdir(directory)).toEqual([])
})

it('refuses seekable non-stream Responses before engine traffic', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-native-replay-'))
  directories.push(directory)
  const replayBudget = new CodexReplaySpoolBudget(directory, 512 * 1024 * 1024, () => {})
  const engineCalls = vi.fn()
  const cleanup = vi.fn()
  const finish = vi.fn()
  const engine = await listen(
    createServer((_req, res) => {
      engineCalls()
      res.end('{}')
    })
  )
  const front = await listen(
    createCodexRoutingHttpServer({
      maxConcurrent: 4,
      maxRequestBytes: 16 * 1024 * 1024,
      maxResponseBytes: 4096,
      responseHeaderTimeoutMs: 1000,
      onCleanupUnverifiable: cleanup,
      replayBudget,
      prepare: () => ({
        port: Number(new URL(engine).port),
        clientKey: engineKey,
        prefix: 'a',
        finish,
        holdUntilOwnerExit: async () => {}
      })
    })
  )
  const response = await fetch(`${front}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: '{"model":"native","stream":false,"input":[]}'
  })
  expect(response.status).toBe(422)
  expect(await response.text()).toContain('non-stream Responses')
  expect(engineCalls).not.toHaveBeenCalled()
  expect(cleanup).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce())
  expect(replayBudget.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
})

it('isolates a local error to its held session while healthy and new sessions remain available', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-native-replay-'))
  directories.push(directory)
  const replayBudget = new CodexReplaySpoolBudget(directory, 512 * 1024 * 1024, () => {})
  let providerSeen = () => {}
  const seen = new Promise<void>((resolve) => {
    providerSeen = resolve
  })
  const provider = await listen(createServer((_req, _res) => providerSeen()))
  let held: ReturnType<typeof request> | undefined
  const engine = await listen(
    createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) {
        body += chunk
      }
      if (body.includes('b/native')) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          trailer: 'x-orca-provider-terminal-v1'
        })
        res.addTrailers({ 'x-orca-provider-terminal-v1': '1' })
        res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n')
        return
      }
      held = request(provider, { method: 'POST' })
      held.on('error', () => {})
      held.end()
      await seen
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":"local timeout while upstream is still live"}')
    })
  )
  let ownerExited = () => {}
  const exited = new Promise<void>((resolve) => {
    ownerExited = resolve
  })
  const finish = vi.fn()
  const healthyFinish = vi.fn()
  let hostClosed = false
  let failedSessionHeld = false
  const cleanup = vi.fn(() => {
    hostClosed = true
  })
  const hold = vi.fn(() => {
    failedSessionHeld = true
    return exited
  })
  const retry = vi.fn()
  const front = await listen(
    createCodexRoutingHttpServer({
      maxConcurrent: 4,
      maxRequestBytes: 16 * 1024 * 1024,
      maxResponseBytes: 4096,
      responseHeaderTimeoutMs: 1000,
      onCleanupUnverifiable: cleanup,
      replayBudget,
      prepare: (sessionToken) => {
        if (hostClosed || (sessionToken === token && failedSessionHeld)) {
          throw new Error('Synthetic session is closed')
        }
        return {
          port: Number(new URL(engine).port),
          clientKey: engineKey,
          prefix: sessionToken === token ? 'a' : 'b',
          finish: sessionToken === token ? finish : healthyFinish,
          holdUntilOwnerExit: hold,
          retryRejectedQuota: retry
        }
      }
    })
  )
  const response = await fetch(`${front}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: '{"model":"native","stream":true,"input":[]}'
  })
  expect(response.status).toBe(500)
  await response.text()
  await vi.waitFor(() => expect(hold).toHaveBeenCalledOnce())
  expect(cleanup).not.toHaveBeenCalled()
  expect(held?.destroyed).toBe(false)
  expect(finish).not.toHaveBeenCalled()
  expect(retry).not.toHaveBeenCalled()
  expect(replayBudget.snapshot().active).toBe(1)
  const fenced = await fetch(`${front}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: '{"model":"native","stream":true,"input":[]}'
  })
  expect(fenced.status).toBe(502)
  await fenced.text()
  for (const sessionToken of [
    'synthetic-healthy-session-1234567890123456',
    'synthetic-new-launch-session-1234567890123456'
  ]) {
    const healthy = await fetch(`${front}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sessionToken}` },
      body: '{"model":"native","stream":true,"input":[]}'
    })
    expect(healthy.status).toBe(200)
    await healthy.text()
  }
  await vi.waitFor(() => expect(healthyFinish).toHaveBeenCalledTimes(2))
  expect(cleanup).not.toHaveBeenCalled()
  expect(finish).not.toHaveBeenCalled()
  expect(hold).toHaveBeenCalledOnce()
  expect(retry).not.toHaveBeenCalled()
  expect(held?.destroyed).toBe(false)
  expect(replayBudget.snapshot().active).toBe(1)
  held?.destroy()
  ownerExited()
  await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce())
  expect(replayBudget.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
  expect(await readdir(directory)).toEqual([])
  expect(cleanup).not.toHaveBeenCalled()
})

it('keeps routing available when native SSE readers stop at the completed event before engine EOF', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-native-completed-close-'))
  directories.push(directory)
  const replayBudget = new CodexReplaySpoolBudget(directory, 512 * 1024 * 1024, () => {})
  const engine = await listen(
    createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* Drain the synthetic request. */
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        trailer: 'x-orca-provider-terminal-v1'
      })
      res.write('event: response.completed\ndata: {"type":"response.completed"}\n\n')
      setTimeout(() => {
        res.addTrailers({ 'x-orca-provider-terminal-v1': '1' })
        res.end()
      }, 40)
    })
  )
  const finish = vi.fn()
  const cleanup = vi.fn()
  const hold = vi.fn(async () => {})
  const front = await listen(
    createCodexRoutingHttpServer({
      maxConcurrent: 4,
      maxRequestBytes: 16 * 1024 * 1024,
      maxResponseBytes: 4096,
      responseHeaderTimeoutMs: 1000,
      onCleanupUnverifiable: cleanup,
      replayBudget,
      prepare: () => ({
        port: Number(new URL(engine).port),
        clientKey: engineKey,
        prefix: 'a',
        finish,
        holdUntilOwnerExit: hold
      })
    })
  )
  await new Promise<void>((resolve, reject) => {
    const req = request(
      `${front}/v1/responses`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      },
      (res) => {
        res.once('data', () => {
          res.destroy()
          resolve()
        })
        res.on('error', () => {})
      }
    )
    req.on('error', reject)
    req.end('{"model":"native","stream":true,"input":[]}')
  })
  await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
  expect(cleanup).not.toHaveBeenCalled()
  expect(hold).not.toHaveBeenCalled()
  const second = await fetch(`${front}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: '{"model":"native","stream":true,"input":[]}'
  })
  expect(second.status).toBe(200)
  await second.text()
  await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(2))
  expect(cleanup).not.toHaveBeenCalled()
  expect(replayBudget.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
  expect(await readdir(directory)).toEqual([])
})
