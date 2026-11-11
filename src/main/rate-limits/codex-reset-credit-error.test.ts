import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }))
vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))

import { consumeCodexRateLimitResetCreditFromBackend } from './codex-reset-credit-client'

const home = join('synthetic', 'codex-home')
const key = 'synthetic-original-key'
const url = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume'

function strictRequest(response: Response): (url: string, init: RequestInit) => Promise<Response> {
  return vi.fn(async (requestedUrl, init) => {
    expect(requestedUrl).toBe(url)
    expect(init).toEqual({
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: 'Bearer synthetic-token',
        'User-Agent': 'codex-cli',
        'OpenAI-Beta': 'codex-1',
        originator: 'Codex Desktop',
        'ChatGPT-Account-Id': 'synthetic-account',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ redeem_request_id: key }),
      signal: expect.any(AbortSignal)
    })
    return response
  })
}

function trackedErrorResponse(
  status: number,
  body: string,
  contentType: string,
  onCancel: () => void
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
      },
      cancel: onCancel
    }),
    { status, headers: { 'Content-Type': contentType } }
  )
}

describe('Codex reset provider rejection', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', join('synthetic', 'unused-home'))
    vi.stubEnv('CODEX_HOME', join('synthetic', 'unused-codex-home'))
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('Unexpected network request')))
    )
    readFileMock.mockResolvedValue(
      JSON.stringify({
        tokens: { access_token: 'synthetic-token', account_id: 'synthetic-account' }
      })
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it.each([
    [
      'known 200 code on 403',
      403,
      '{"code":"no_credit","message":"Bearer should-never-appear"}',
      'application/json'
    ],
    ['HTML', 403, '<html>Bearer should-never-appear</html>', 'text/html'],
    ['malformed JSON', 403, '{bad-json}', 'application/json'],
    ['oversized JSON', 403, 'x'.repeat(8192), 'application/json'],
    ['401 text', 401, '{"error":{"message":"sign in to a different account"}}', 'application/json']
  ] as const)(
    'reports %s with an unknown reason and cancels its body',
    async (_case, status, body, contentType) => {
      const cancelled = vi.fn()
      const request = strictRequest(trackedErrorResponse(status, body, contentType, cancelled))

      await expect(
        consumeCodexRateLimitResetCreditFromBackend(
          { codexHomePath: home, idempotencyKey: key },
          request
        )
      ).rejects.toThrow(
        `Codex provider rejected the reset request (HTTP ${status}; reason unknown). The reset outcome is unconfirmed.`
      )
      expect(cancelled).toHaveBeenCalledOnce()
      expect(request).toHaveBeenCalledOnce()
      expect(readFileMock).toHaveBeenCalledWith(join(home, 'auth.json'), 'utf8')
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it('keeps a body-free 403 as an unknown provider rejection', async () => {
    const request = strictRequest(new Response(null, { status: 403 }))
    await expect(
      consumeCodexRateLimitResetCreditFromBackend(
        { codexHomePath: home, idempotencyKey: key },
        request
      )
    ).rejects.toThrow('HTTP 403; reason unknown')
    expect(request).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['reset', 'reset'],
    ['nothing_to_reset', 'nothingToReset'],
    ['no_credit', 'noCredit'],
    ['already_redeemed', 'alreadyRedeemed']
  ] as const)('keeps the 200 %s outcome', async (code, outcome) => {
    const request = strictRequest(Response.json({ code }))
    await expect(
      consumeCodexRateLimitResetCreditFromBackend(
        { codexHomePath: home, idempotencyKey: key },
        request
      )
    ).resolves.toBe(outcome)
    expect(fetch).not.toHaveBeenCalled()
  })
})
