import type { ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexEngineSessions } from './codex-engine-sessions'
import { CodexEngineRequestRecovery } from './codex-engine-request-recovery'
import { engineHostFixture } from './codex-engine-host-fixture'

const fixtures: ReturnType<typeof engineHostFixture>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.cleanup()
  }
})
function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const metadata = JSON.stringify({ thread_id: 'retained-thread', turn_id: 'retained-turn' })
function post(launch: { baseUrl: string; apiKey: string }, input: string, signal?: AbortSignal) {
  return fetch(`${launch.baseUrl}/responses`, {
    method: 'POST',
    signal,
    headers: {
      authorization: `Bearer ${launch.apiKey}`,
      'content-type': 'application/json',
      'x-codex-turn-metadata': metadata
    },
    body: JSON.stringify({ model: 'synthetic', stream: true, input })
  })
}
function complete(response: ServerResponse) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    trailer: 'x-orca-provider-terminal-v1'
  })
  response.addTrailers({ 'x-orca-provider-terminal-v1': '1' })
  response.end('event: response.completed\ndata: {"type":"response.completed"}\n\n')
}

it('continues the cancelled native session without restarting or waiting for other healthy work', async () => {
  const failedSeen = deferred(),
    healthySeen = deferred(),
    healthyDone = deferred()
  const forwarded: { model: string; input: string; metadata: string | string[] | undefined }[] = []
  let fail = true
  const fixture = engineHostFixture(2000, {
    replay: true,
    respond: async (request, response, payload) => {
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('input' in payload) ||
        typeof payload.input !== 'string' ||
        !('model' in payload) ||
        typeof payload.model !== 'string'
      ) {
        throw new Error('Missing synthetic request')
      }
      forwarded.push({
        model: payload.model,
        input: payload.input,
        metadata: request.headers['x-codex-turn-metadata']
      })
      if (payload.input === 'retained-history' && fail) {
        fail = false
        failedSeen.resolve()
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n'
        )
        await new Promise<void>((resolve) => response.once('close', resolve))
      } else if (payload.input === 'healthy') {
        healthySeen.resolve()
        await healthyDone.promise
        complete(response)
      } else {
        complete(response)
      }
      return true
    }
  })
  fixtures.push(fixture)
  const first = await fixture.launch('interrupted'),
    second = await fixture.launch('healthy')
  const original = { baseUrl: first.baseUrl, apiKey: first.apiKey, routingKey: first.routingKey }
  const interrupted = new AbortController()
  const failed = await post(first, 'retained-history', interrupted.signal)
  expect(failed.status).toBe(200)
  const reader = failed.body?.getReader()
  expect((await reader?.read())?.done).toBe(false)
  await failedSeen.promise
  const healthy = post(second, 'healthy')
  await healthySeen.promise
  interrupted.abort()
  const recovery = Reflect.get(fixture.host, 'requestRecovery')
  const sessions = Reflect.get(fixture.host, 'sessions')
  if (
    !(recovery instanceof CodexEngineRequestRecovery) ||
    !(sessions instanceof CodexEngineSessions)
  ) {
    throw new Error('Synthetic host recovery is unavailable')
  }
  await vi.waitFor(() => expect(first.readActiveRequests()).toBe(0))
  expect(sessions.hasHeldRequests).toBe(false)
  expect(recovery.phase).toBe('idle')
  expect(second.readActiveRequests()).toBe(1)
  const retry = await post(first, 'retained-history')
  expect(retry.status).toBe(200)
  await retry.text()
  expect(fixture.stats.stopAttempts).toBe(0)
  expect(fixture.stats.starts).toBe(1)
  expect(second.readActiveRequests()).toBe(1)
  healthyDone.resolve()
  const healthyResponse = await healthy
  expect(healthyResponse.status).toBe(200)
  await healthyResponse.text()
  expect({ baseUrl: first.baseUrl, apiKey: first.apiKey, routingKey: first.routingKey }).toEqual(
    original
  )
  expect(fixture.host.getNativeClientKey()).toBe(original.apiKey)
  const retained = forwarded.filter((request) => request.input === 'retained-history')
  expect(retained).toHaveLength(2)
  expect(retained[1]).toEqual(retained[0])
  expect(fixture.stats.bindings.every((binding) => binding.accountId === fixture.a.id)).toBe(true)
  expect(fixture.stats.maximum).toBe(1)
  await vi.waitFor(() => expect(first.readActiveRequests()).toBe(0))
})

it('keeps the interrupted lease and session fenced if engine exit is unverifiable', async () => {
  const fixture = engineHostFixture(2000, {
    replay: true,
    respond: async (_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end('{"error":"synthetic ambiguous upstream"}')
      return true
    }
  })
  fixtures.push(fixture)
  const first = await fixture.launch('interrupted')
  await fixture.launch('healthy')
  fixture.stats.stopVerdict = 'unverifiable'
  const response = await post(first, 'retained-history')
  expect(response.status).toBe(500)
  await response.text()
  await vi.waitFor(() => expect(fixture.stats.stopAttempts).toBe(1))
  expect(first.readActiveRequests()).toBe(1)
  expect(fixture.stats.starts).toBe(1)
  expect(fixture.stats.residents).toBe(1)
  expect(fixture.stats.bindings.every((binding) => binding.accountId === fixture.a.id)).toBe(true)
  expect(fixture.host.getNativeClientKey()).toBe(first.apiKey)
})

it('does not restart when a native caller closes after receiving a completed event', async () => {
  const fixture = engineHostFixture(2000, {
    replay: true,
    respond: async (_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        trailer: 'x-orca-provider-terminal-v1'
      })
      response.write('event: response.completed\ndata: {"type":"response.completed"}\n\n')
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      response.addTrailers({ 'x-orca-provider-terminal-v1': '1' })
      response.end()
      return true
    }
  })
  fixtures.push(fixture)
  const launch = await fixture.launch('completed-reader')
  const controller = new AbortController()
  const first = await post(launch, 'retained-history', controller.signal)
  expect(first.status).toBe(200)
  const reader = first.body?.getReader()
  expect((await reader?.read())?.done).toBe(false)
  controller.abort()
  const next = await post(launch, 'retained-history')
  expect(next.status).toBe(200)
  await next.text()
  await vi.waitFor(() => expect(launch.readActiveRequests()).toBe(0))
  expect(fixture.stats.starts).toBe(1)
  expect(fixture.stats.stopAttempts).toBe(0)
})

it('queues past the short engine-transition deadline while healthy work is still running', async () => {
  const healthySeen = deferred(),
    healthyDone = deferred()
  let prefixes = new Set<string>()
  let failed = false
  const fixture = engineHostFixture(20, {
    replay: true,
    readPrefixes: async () => prefixes,
    respond: async (_request, response, payload) => {
      if (
        payload &&
        typeof payload === 'object' &&
        'input' in payload &&
        payload.input === 'healthy'
      ) {
        healthySeen.resolve()
        await healthyDone.promise
        complete(response)
      } else if (!failed) {
        failed = true
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end('{"error":"synthetic ambiguous upstream"}')
      } else {
        complete(response)
      }
      return true
    }
  })
  fixtures.push(fixture)
  const a = fixture.host.readConnection(fixture.a.id),
    b = fixture.host.readConnection(fixture.b.id)
  if (!a || !b) {
    throw new Error('Synthetic connections are unavailable')
  }
  prefixes = new Set([a.prefix, b.prefix])
  const first = await fixture.launch('interrupted'),
    second = await fixture.launch('healthy')
  const healthy = post(second, 'healthy')
  await healthySeen.promise
  const failure = await post(first, 'retained-history')
  expect(failure.status).toBe(500)
  await failure.text()
  const queued = post(first, 'retained-history')
  const release = setTimeout(healthyDone.resolve, 80)
  try {
    const next = await queued
    expect(next.status).toBe(200)
    await next.text()
    const completed = await healthy
    expect(completed.status).toBe(200)
    await completed.text()
    expect(fixture.stats.starts).toBe(2)
    expect(fixture.stats.maximum).toBe(1)
  } finally {
    clearTimeout(release)
    healthyDone.resolve()
  }
})

it('keeps an unrequested engine stream failure fenced until engine exit is proven', async () => {
  const fixture = engineHostFixture(2000, {
    replay: true,
    respond: async (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"type":"response.created"}\n\n')
      setImmediate(() => response.destroy(new Error('Synthetic engine transport failure')))
      return true
    }
  })
  fixtures.push(fixture)
  fixture.stats.stopVerdict = 'unverifiable'
  const launch = await fixture.launch('unexpected-engine-disconnect')
  const response = await post(launch, 'retained-history').catch(() => null)
  await response?.text().catch(() => '')
  await vi.waitFor(() => expect(fixture.stats.stopAttempts).toBe(1))
  expect(launch.readActiveRequests()).toBe(1)
  expect(fixture.stats.starts).toBe(1)
})
