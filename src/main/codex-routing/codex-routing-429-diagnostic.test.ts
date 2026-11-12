import { afterEach, expect, it, vi } from 'vitest'
import { recordLocalCodex429, recordUpstreamCodex429 } from './codex-routing-429-diagnostic'

afterEach(() => vi.restoreAllMocks())

it('records a recognized upstream quota code without body or account data', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  recordUpstreamCodex429({
    body: Buffer.from(
      JSON.stringify({
        error: {
          code: 'usage_limit_reached',
          type: 'rate_limit_error',
          message: 'private prompt and key',
          account: 'private account'
        }
      })
    ),
    contentType: 'application/json',
    complete: true,
    terminal: true,
    retryAfter: '42',
    failure: { kind: 'quota', code: 'usage_limit_reached', resetsAt: 1_800_000_000_000 }
  })
  expect(warn).toHaveBeenCalledWith('[codex-routing] 429', {
    origin: 'upstream',
    status: 429,
    code: 'usage_limit_reached',
    type: 'rate_limit_error',
    complete: true,
    terminal: true,
    retryAfterSeconds: 42,
    resetAt: 1_800_000_000_000
  })
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|account|prompt|key/)
})

it('reduces unrecognized or incomplete rejection fields to fixed values', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  recordUpstreamCodex429({
    body: Buffer.from('{"error":{"code":"secret-code","type":"secret-type"}}'),
    contentType: 'application/json',
    complete: true,
    terminal: false,
    retryAfter: '999999'
  })
  recordUpstreamCodex429({
    body: Buffer.from('{"error":{"code":"usage_limit_reached"}}'),
    contentType: 'application/json',
    complete: false,
    terminal: false
  })
  expect(warn.mock.calls).toEqual([
    [
      '[codex-routing] 429',
      {
        origin: 'upstream',
        status: 429,
        code: 'unrecognized',
        type: 'unrecognized',
        complete: true,
        terminal: false
      }
    ],
    [
      '[codex-routing] 429',
      {
        origin: 'upstream',
        status: 429,
        code: 'unrecognized',
        type: 'unrecognized',
        complete: false,
        terminal: false
      }
    ]
  ])
})

it('records local admission sources with fixed fields', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  recordLocalCodex429('native-affinity')
  expect(warn).toHaveBeenCalledWith('[codex-routing] 429', {
    origin: 'native-affinity',
    status: 429,
    code: 'unrecognized',
    type: 'unrecognized',
    complete: true,
    terminal: false
  })
})
