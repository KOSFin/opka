import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'
import { openClaudeNativeGatewayUpstream } from './claude-native-gateway-upstream'

const { proxy } = vi.hoisted(() => ({ proxy: vi.fn<() => Promise<void>>(async () => undefined) }))
vi.mock('../network/proxy-settings', () => ({ ensureElectronProxyFromEnvironment: proxy }))

beforeEach(() => {
  proxy.mockReset().mockResolvedValue(undefined)
})
afterEach(() => setMainHttpClient(null))
const body = Buffer.from('native request bytes')
const options = () => ({
  path: '/v1/messages?beta=true',
  headers: { authorization: 'Bearer synthetic-access', 'content-type': 'application/json' },
  body,
  signal: new AbortController().signal
})

it('uses the host HTTP client after egress preparation and preserves native response bytes', async () => {
  const order: string[] = []
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    order.push('fetch')
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store'
    })
    expect(Buffer.from(await new Response(init?.body).arrayBuffer())).toEqual(body)
    return new Response(new Uint8Array([0, 255, 10, 13]), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '2' }
    })
  })
  proxy.mockImplementation(async () => {
    order.push('proxy')
  })
  setMainHttpClient({ fetch, proxySession: () => null })
  const upstream = await openClaudeNativeGatewayUpstream({
    ...options(),
    beforeSend: () => {
      order.push('admit')
    }
  })
  expect(order).toEqual(['proxy', 'admit', 'fetch'])
  expect(fetch.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/messages?beta=true')
  expect(proxy).toHaveBeenCalledWith({
    probeUrl: 'https://api.anthropic.com/v1/messages?beta=true'
  })
  expect(upstream.complete).toBe(false)
  const chunks: Buffer[] = []
  for await (const chunk of upstream) {
    chunks.push(chunk)
  }
  expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 10, 13]))
  expect(upstream.statusCode).toBe(429)
  expect(upstream.headers['retry-after']).toBe('2')
  expect(upstream.complete).toBe(true)
  await upstream.closeBody()
})

it('never accepts an alternate provider, query or absolute URL', async () => {
  const fetch = vi.fn()
  setMainHttpClient({ fetch, proxySession: () => null })
  for (const path of [
    'https://other.invalid/v1/messages',
    '/v1/messages?other=true',
    '/v1/files',
    '//other.invalid'
  ]) {
    await expect(openClaudeNativeGatewayUpstream({ ...options(), path })).rejects.toThrow(
      'unsupported'
    )
  }
  expect(proxy).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('does not admit or send when cancelled during proxy preparation', async () => {
  let unblock = () => {}
  proxy.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        unblock = resolve
      })
  )
  const controller = new AbortController(),
    fetch = vi.fn(),
    beforeSend = vi.fn()
  setMainHttpClient({ fetch, proxySession: () => null })
  const pending = openClaudeNativeGatewayUpstream({
    ...options(),
    signal: controller.signal,
    beforeSend
  })
  controller.abort()
  unblock()
  await expect(pending).rejects.toThrow()
  expect(beforeSend).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('checks final account admission after awaited proxy work and before any HTTP send', async () => {
  const fetch = vi.fn()
  setMainHttpClient({ fetch, proxySession: () => null })
  await expect(
    openClaudeNativeGatewayUpstream({
      ...options(),
      beforeSend: () => {
        throw new Error('changed admission')
      }
    })
  ).rejects.toThrow('changed admission')
  expect(proxy).toHaveBeenCalledTimes(1)
  expect(fetch).not.toHaveBeenCalled()
})

it('joins cancellation even when the returned body was never consumed', async () => {
  let finishCancel = () => {},
    cancelled = 0
  const cancellation = new Promise<void>((resolve) => {
    finishCancel = resolve
  })
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++
      return cancellation
    }
  })
  setMainHttpClient({ fetch: async () => new Response(source), proxySession: () => null })
  const upstream = await openClaudeNativeGatewayUpstream(options())
  let closed = false
  const closing = upstream.closeBody().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(cancelled).toBe(1)
  expect(closed).toBe(false)
  finishCancel()
  await closing
  expect(source.locked).toBe(false)
  expect(upstream.complete).toBe(false)
  await upstream.closeBody()
  expect(cancelled).toBe(1)
})

it('joins cancellation of decoded bytes carrying a compressed-response header', async () => {
  let finishCancel = () => {},
    cancelled = 0
  const cancellation = new Promise<void>((resolve) => {
    finishCancel = resolve
  })
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++
      return cancellation
    }
  })
  setMainHttpClient({
    fetch: async (_url, init) => {
      expect(new Headers(init?.headers).get('accept-encoding')).toBe('identity')
      return new Response(source, { headers: { 'content-encoding': 'gzip' } })
    },
    proxySession: () => null
  })
  let settled = false
  const pending = openClaudeNativeGatewayUpstream(options()).finally(() => {
    settled = true
  })
  await vi.waitFor(() => expect(cancelled).toBe(1))
  expect(settled).toBe(false)
  finishCancel()
  await expect(pending).rejects.toThrow('encoding is unsupported')
})
