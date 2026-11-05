import { createServer, request } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import {
  startClaudeNativeGatewayHttpForTest,
  type ClaudeNativeGatewayRoute
} from './claude-native-gateway-http'
import {
  claimClaudeNativeGatewayRequest,
  readClaudeNativeGatewayBudget
} from './claude-native-gateway-budget'

const cleanups: (() => Promise<void>)[] = []
const accountA = randomUUID(),
  accountB = randomUUID(),
  nativeSession = randomUUID(),
  cap = 'opaque-native-capability-'.repeat(3)
const wire = Buffer.from(
  JSON.stringify({
    model: 'native-model',
    messages: [{ role: 'user', content: 'original accepted request' }],
    metadata: {
      user_id: JSON.stringify({
        account_uuid: accountA,
        session_id: nativeSession,
        device_id: 'native-device'
      })
    }
  })
)
const quota = '{"error":{"type":"rate_limit_error","message":"unchanged failure"}}'
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
  await vi.waitFor(() => expect(readClaudeNativeGatewayBudget().active).toBe(0))
})
async function fixture(
  options: {
    parallel?: boolean
    status?: number
    body?: string
    headers?: Record<string, string>
    retry?: boolean
    pending?: (signal: AbortSignal) => Promise<ClaudeNativeGatewayRoute | null>
  } = {}
) {
  vi.stubEnv('OPKA_SYNTHETIC_LOOPBACK_SCOPE', '1')
  const received: { token?: string; account: string; original: boolean; privateKey?: string }[] = []
  const held: (() => void)[] = []
  const upstream = createServer(async (incoming, outgoing) => {
    let raw = ''
    for await (const chunk of incoming) {
      raw += chunk
    }
    const body = JSON.parse(raw)
    received.push({
      token: incoming.headers.authorization,
      account: JSON.parse(body.metadata.user_id).account_uuid,
      original: body.messages[0].content === 'original accepted request',
      privateKey: incoming.headers['x-api-key']?.toString()
    })
    if (options.parallel) {
      held.push(() => {
        outgoing
          .writeHead(200, { 'content-type': 'text/event-stream' })
          .end('data: parallel native bytes\n\n')
      })
      if (held.length === 2) {
        for (const respond of held) {
          respond()
        }
      }
      return
    }
    if (received.length === 1) {
      outgoing
        .writeHead(options.status ?? 429, options.headers ?? { 'content-type': 'application/json' })
        .end(options.body ?? quota)
    } else {
      outgoing
        .writeHead(200, {
          'content-type': 'text/event-stream',
          'anthropic-ratelimit-unified-status': 'allowed'
        })
        .end('data: native bytes\n\n')
    }
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })
  const address = upstream.address()
  if (!address || typeof address === 'string') {
    throw new Error('Loopback fixture missing.')
  }
  const finishes: string[] = [],
    accepted: string[] = []
  const route = (id: string): ClaudeNativeGatewayRoute => ({
    accountId: id,
    quotaIdentity: id,
    accountUuid: id === 'A' ? accountA : accountB,
    accessToken: `source-only-${id}`,
    beforeSend: () => {},
    accepted: () => {
      accepted.push(id)
    },
    finish: () => {
      finishes.push(id)
    }
  })
  const retry = vi.fn(async ({ signal }: { signal: AbortSignal }) =>
    options.pending ? options.pending(signal) : options.retry === false ? null : route('B')
  )
  const gateway = await startClaudeNativeGatewayHttpForTest(
    {
      capability: cap,
      nativeAccountUuid: accountA,
      prepare: async () => route('A'),
      retryRejected: retry,
      totalTimeoutMs: 1000
    },
    new URL(`http://127.0.0.1:${address.port}`)
  )
  cleanups.push(gateway.close)
  const send = (headers: Record<string, string> = {}, path = '/v1/messages?beta=true') =>
    fetch(gateway.baseUrl + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${cap}`, 'content-type': 'application/json', ...headers },
      body: wire
    })
  return { ...gateway, send, received, retry, finishes, accepted, route }
}

it('retries only an unexposed rejected request and preserves native successful SSE bytes', async () => {
  const f = await fixture()
  const response = await f.send({
    'x-api-key': 'inherited-untrusted',
    'anthropic-organization-id': accountA
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('data: native bytes\n\n')
  expect(response.headers.get('anthropic-ratelimit-unified-status')).toBe('allowed')
  expect(f.received).toEqual([
    { token: 'Bearer source-only-A', account: accountA, original: true },
    { token: 'Bearer source-only-B', account: accountB, original: true }
  ])
  expect(f.accepted).toEqual(['B'])
  await vi.waitFor(() => expect(f.finishes).toEqual(['A', 'B']))
})

it.each([
  {
    status: 200,
    body: 'data: partial-native-error\n\n',
    headers: { 'content-type': 'text/event-stream' }
  },
  { status: 401, body: '{"error":{"type":"authentication_error"}}' },
  { status: 529, body: quota },
  { body: '{"error":{"type":"other"}}' },
  { body: 'not JSON' },
  { body: 'x'.repeat(17 * 1024) }
])('forwards nonretryable provider responses without inventing quota', async (options) => {
  const f = await fixture(options)
  const response = await f.send()
  expect(response.status).toBe(options.status ?? 429)
  expect(await response.text()).toBe(options.body)
  expect(f.received).toHaveLength(1)
  expect(f.retry).not.toHaveBeenCalled()
})

it('preserves confirmed-but-unavailable quota response and does not adopt a replacement', async () => {
  const f = await fixture({ retry: false })
  const response = await f.send()
  expect(response.status).toBe(429)
  expect(await response.text()).toBe(quota)
  expect(f.accepted).toEqual([])
})

const rejectedHeaders: Record<string, string>[] = [
  { origin: 'https://untrusted.invalid' },
  { authorization: `Bearer ${'é'.repeat(cap.length)}` },
  { authorization: 'Bearer wrong-capability' }
]
it.each(rejectedHeaders)(
  'refuses invalid local authority before provider contact',
  async (headers) => {
    const f = await fixture()
    expect((await f.send(headers)).status).toBe(401)
    expect(f.received).toEqual([])
  }
)

it('checks the actual wire Host rather than a fetch header overridden by the HTTP client', async () => {
  const f = await fixture()
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const outgoing = request(
      `${f.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          host: 'localhost',
          authorization: `Bearer ${cap}`,
          'content-length': wire.length
        }
      },
      (response) => {
        response.resume()
        resolve(response.statusCode)
      }
    )
    outgoing.on('error', reject)
    outgoing.end(wire)
  })
  expect(status).toBe(401)
  expect(f.received).toEqual([])
})

it('refuses unknown path/query and revoked capability without contacting the provider', async () => {
  const f = await fixture()
  expect((await f.send({}, '/v1/messages?unknown=true')).status).toBe(401)
  f.revoke()
  expect((await f.send()).status).toBe(401)
  expect(f.received).toEqual([])
})

it('holds one launch barrier across async evidence and disposes a cancelled late candidate exactly once', async () => {
  let deliver: ((route: ClaudeNativeGatewayRoute | null) => void) | undefined
  const f = await fixture({
    pending: () =>
      new Promise((resolve) => {
        deliver = resolve
      })
  })
  const first = f.send()
  await vi.waitFor(() => expect(deliver).toBeTypeOf('function'))
  expect((await f.send()).status).toBe(503)
  f.revoke()
  await first.catch(() => {})
  deliver?.(f.route('B'))
  await vi.waitFor(() => expect(f.finishes).toEqual(['A', 'B']))
  expect(f.accepted).toEqual([])
  expect(f.received).toHaveLength(1)
})

it('bounds resident claims across different launches and returns all claims after release', () => {
  const before = readClaudeNativeGatewayBudget()
  const first = claimClaudeNativeGatewayRequest(before.maxRequestBytes)
  expect(first).not.toBeNull()
  expect(claimClaudeNativeGatewayRequest(before.maxRequestBytes)).toBeNull()
  first?.()
  first?.()
  expect(readClaudeNativeGatewayBudget()).toMatchObject({ active: 0, resident: 0 })
})

it('preserves parallel current-account requests without applying replacement quiet rules', async () => {
  const f = await fixture({ parallel: true })
  const responses = await Promise.all([f.send(), f.send()])
  expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
    'data: parallel native bytes\n\n',
    'data: parallel native bytes\n\n'
  ])
  expect(f.received.map((entry) => entry.account)).toEqual([accountA, accountA])
  expect(f.retry).not.toHaveBeenCalled()
  expect(f.accepted).toEqual(['A', 'A'])
})

it('joins cancelled evidence cleanup before close completes and retains its resident claim until then', async () => {
  let deliver: ((route: ClaudeNativeGatewayRoute | null) => void) | undefined
  const f = await fixture({
    pending: () =>
      new Promise((resolve) => {
        deliver = resolve
      })
  })
  const first = f.send().catch(() => {})
  await vi.waitFor(() => expect(deliver).toBeTypeOf('function'))
  let closed = false
  const closing = f.close().then(() => {
    closed = true
  })
  await first
  expect(closed).toBe(false)
  expect(readClaudeNativeGatewayBudget().active).toBe(1)
  deliver?.(f.route('B'))
  await closing
  expect(f.accepted).toEqual([])
  expect(f.finishes).toEqual(['A', 'B'])
  expect(readClaudeNativeGatewayBudget()).toMatchObject({ active: 0, resident: 0 })
})
