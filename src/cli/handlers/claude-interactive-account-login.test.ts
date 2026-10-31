import { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import type { InteractiveLoginSession } from './interactive-login-interruption'
import {
  CLAUDE_INTERACTIVE_SIGN_IN_ARGS,
  runInteractiveClaudeAccountLogin
} from './claude-interactive-account-login'

const { terminate } = vi.hoisted(() => ({ terminate: vi.fn() }))
vi.mock('./interactive-login-interruption', () => ({ terminateInteractiveLoginProcess: terminate }))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})
function setup() {
  const child = new ChildProcess()
  const session: InteractiveLoginSession = { child, registering: false, terminationPromise: null }
  const stopped = Promise.withResolvers<void>()
  terminate.mockImplementation(async () => {
    stopped.resolve()
    session.child = null
  })
  const run = vi.fn(async () => stopped.promise)
  const call = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the helper invokes only client.call, supplied by this test.
  const client = { call } as unknown as HandlerContext['client']
  return { session, run, call, client, stopped, child }
}
const signIn = {
  accountId: 'managed-claude',
  configDir: '/managed/config',
  runtime: 'host'
} as const
const result = {
  id: 'rpc',
  ok: true,
  result: { accounts: [] },
  _meta: { runtimeId: 'host' }
} as const

describe('Claude terminal account registration', () => {
  it('waits for host registration proof then stops only its own TUI', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.call
      .mockResolvedValueOnce({ result: { ready: false } })
      .mockResolvedValueOnce({ result: { ready: true } })
      .mockResolvedValue(result)
    const done = runInteractiveClaudeAccountLogin(
      { client: h.client, json: false },
      signIn,
      h.session,
      h.run
    )
    await vi.advanceTimersByTimeAsync(1000)
    await expect(done).resolves.toBe(result)
    expect(h.call).toHaveBeenCalledTimes(3)
    expect(h.session.registering).toBe(true)
    expect(terminate).toHaveBeenCalledExactlyOnceWith(h.child, 'SIGTERM')
    expect(h.run).toHaveBeenCalledWith(
      'claude',
      CLAUDE_INTERACTIVE_SIGN_IN_ARGS,
      expect.objectContaining({
        CLAUDE_CONFIG_DIR: '/managed/config',
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_OAUTH_TOKEN: ''
      }),
      false,
      h.session
    )
    expect(CLAUDE_INTERACTIVE_SIGN_IN_ARGS).toEqual(
      expect.arrayContaining([
        '--strict-mcp-config',
        '--tools',
        '',
        '{"disableAllHooks":true}',
        '/login'
      ])
    )
  })
  it('does not infer successful sign-in from a clean CLI exit', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.call.mockResolvedValue({ result: { ready: false } })
    const done = runInteractiveClaudeAccountLogin(
      { client: h.client, json: false },
      signIn,
      h.session,
      h.run
    )
    const rejection = expect(done).rejects.toThrow('exited before sign-in')
    h.stopped.resolve()
    await vi.advanceTimersByTimeAsync(1000)
    await rejection
    expect(h.session.registering).toBe(false)
  })
  it('stops the owned TUI before propagating an unexpected host failure', async () => {
    const h = setup()
    h.call.mockRejectedValue(new Error('host disconnected'))
    await expect(
      runInteractiveClaudeAccountLogin({ client: h.client, json: false }, signIn, h.session, h.run)
    ).rejects.toThrow('host disconnected')
    expect(terminate).toHaveBeenCalledExactlyOnceWith(h.child, 'SIGTERM')
    expect(h.session.registering).toBe(false)
  })
  it('preserves the pending folder when stopping the TUI cannot be proven', async () => {
    const h = setup()
    h.call.mockResolvedValue({ result: { ready: true } })
    terminate.mockImplementation(async () => {})
    await expect(
      runInteractiveClaudeAccountLogin({ client: h.client, json: false }, signIn, h.session, h.run)
    ).rejects.toThrow('could not be confirmed stopped')
    expect(h.call).not.toHaveBeenCalledWith('accounts.finishClaudeSignIn', expect.anything())
    expect(h.session.registering).toBe(false)
    h.stopped.resolve()
  })
})
