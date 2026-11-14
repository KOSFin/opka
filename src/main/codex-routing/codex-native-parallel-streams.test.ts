import { once } from 'node:events'
import { mkdtemp, readdir, readlink, rm } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createCodexRoutingHttpServer } from './codex-routing-http-server'
import { CodexReplaySpoolBudget } from './codex-replay-spool'

const servers: Server[] = []
const directories: string[] = []
const token = 'synthetic-parallel-native-1234567890123456'
const engineKey = 'synthetic-parallel-engine-1234567890123456'

async function listen(server: Server): Promise<string> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing synthetic listener')
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

it('keeps 100 native SSE streams open together, routes the next turn, and releases every spool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-native-parallel-'))
  directories.push(directory)
  const budget = new CodexReplaySpoolBudget(directory, 0, () => {})
  const held: ServerResponse[] = []
  const bodies: string[] = []
  const finished = vi.fn()
  const cleanup = vi.fn()
  let account = 'account-A'
  const engine = await listen(
    createServer(async (incoming, outgoing) => {
      let body = ''
      for await (const chunk of incoming) {
        body += chunk.toString()
      }
      bodies.push(body)
      outgoing.writeHead(200, {
        'content-type': 'text/event-stream',
        trailer: 'x-orca-provider-terminal-v1'
      })
      outgoing.write('data: {"type":"response.created"}\n\n')
      held.push(outgoing)
    })
  )
  const front = await listen(
    createCodexRoutingHttpServer({
      maxConcurrent: 1,
      maxRequestBytes: 1024,
      maxResponseBytes: 1024,
      responseHeaderTimeoutMs: 30_000,
      replayBudget: budget,
      onCleanupUnverifiable: cleanup,
      prepare: () => ({
        port: Number(new URL(engine).port),
        clientKey: engineKey,
        prefix: account,
        finish: finished,
        holdUntilOwnerExit: async () => {}
      })
    })
  )
  const history = [{ role: 'user', content: 'retained synthetic history' }]
  const post = () =>
    fetch(`${front}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'native', stream: true, input: history })
    })
  const responses = await Promise.all(Array.from({ length: 100 }, post))
  expect(responses.map((response) => response.status)).toEqual(Array(100).fill(200))
  expect(held).toHaveLength(100)
  expect(budget.snapshot().active).toBe(100)
  expect(await readdir(directory)).toEqual([])
  const end = (response: ServerResponse) => {
    response.addTrailers({ 'x-orca-provider-terminal-v1': '1' })
    response.end('data: {"type":"response.completed"}\n\n')
  }
  held.splice(0).forEach(end)
  for (const response of responses) {
    expect(await response.text()).toContain('response.completed')
  }
  await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(100))
  expect(budget.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
  account = 'account-B'
  const next = await post()
  end(held[0])
  expect(await next.text()).toContain('response.completed')
  expect(JSON.parse(bodies[0])).toMatchObject({ model: 'account-A/native', input: history })
  expect(JSON.parse(bodies[100])).toMatchObject({ model: 'account-B/native', input: history })
  await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(101))
  expect(budget.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
  expect(await readdir(directory)).toEqual([])
  expect(cleanup).not.toHaveBeenCalled()
  if (process.platform === 'linux') {
    const names = await readdir('/proc/self/fd')
    const targets = await Promise.all(
      names.map((name) => readlink(`/proc/self/fd/${name}`).catch(() => ''))
    )
    expect(targets.filter((target) => target.includes(directory))).toEqual([])
  }
}, 60_000)

it('admits more than two large native requests without allocating whole payloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-native-large-parallel-'))
  directories.push(directory)
  const budget = new CodexReplaySpoolBudget(directory, 0, () => {})
  const spools = Array.from({ length: 5 }, () => budget.acquire())
  const chunk = Buffer.alloc(64 * 1024, 65)
  async function* source() {
    yield Buffer.from('{"model":"native","stream":true,"input":"')
    for (let index = 0; index < 272; index++) {
      yield chunk
    }
    yield Buffer.from('"}')
  }
  await Promise.all(spools.map((spool) => spool.ingest(source())))
  expect(budget.snapshot()).toMatchObject({ active: 5, large: 5 })
  expect(await readdir(directory)).toEqual([])
  await Promise.all(spools.map((spool) => spool.dispose()))
  expect(budget.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
}, 60_000)

it('cancels one native delivery without holding its lease or interrupting 99 other streams', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-native-cancel-parallel-'))
  directories.push(directory)
  const budget = new CodexReplaySpoolBudget(directory, 0, () => {})
  const held = new Set<ServerResponse>()
  const finish = vi.fn()
  const onHeld = vi.fn()
  const cleanup = vi.fn()
  const holdUntilOwnerExit = vi.fn(() => new Promise<void>(() => {}))
  const engine = await listen(
    createServer(async (incoming, outgoing) => {
      for await (const _chunk of incoming) {
        /* Drain only synthetic input. */
      }
      held.add(outgoing)
      outgoing.once('close', () => held.delete(outgoing))
      outgoing.writeHead(200, {
        'content-type': 'text/event-stream',
        trailer: 'x-orca-provider-terminal-v1'
      })
      outgoing.write('data: {"type":"response.created"}\n\n')
    })
  )
  const front = await listen(
    createCodexRoutingHttpServer({
      maxConcurrent: 1,
      maxRequestBytes: 1024,
      maxResponseBytes: 1024,
      responseHeaderTimeoutMs: 30_000,
      replayBudget: budget,
      onCleanupUnverifiable: cleanup,
      onRequestHeld: onHeld,
      prepare: () => ({
        port: Number(new URL(engine).port),
        clientKey: engineKey,
        prefix: 'a',
        finish,
        holdUntilOwnerExit
      })
    })
  )
  const post = (signal?: AbortSignal) =>
    fetch(`${front}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '{"model":"native","stream":true,"input":[]}',
      signal
    })
  const controller = new AbortController()
  const cancelled = await post(controller.signal)
  const others = await Promise.all(Array.from({ length: 99 }, () => post()))
  expect(held.size).toBe(100)
  const cancelledBody = cancelled.text().catch(() => '')
  controller.abort()
  await cancelledBody
  await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(held.size).toBe(99))
  expect(budget.snapshot().active).toBe(99)
  expect(onHeld).not.toHaveBeenCalled()
  expect(holdUntilOwnerExit).not.toHaveBeenCalled()
  const next = await post()
  expect(next.status).toBe(200)
  expect(held.size).toBe(100)
  for (const response of held) {
    response.addTrailers({ 'x-orca-provider-terminal-v1': '1' })
    response.end('data: {"type":"response.completed"}\n\n')
  }
  for (const response of [...others, next]) {
    expect(await response.text()).toContain('response.completed')
  }
  await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(101))
  expect(budget.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
  expect(cleanup).not.toHaveBeenCalled()
}, 60_000)
