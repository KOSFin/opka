import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeClient } from './runtime-client'
import { okFixture } from './test-fixtures'
import type { streamRuntimeRequest } from './runtime/stream-request'
const mocks = vi.hoisted(() => ({ stream: vi.fn<typeof streamRuntimeRequest>() }))
vi.mock('./runtime/stream-request', () => ({ streamRuntimeRequest: mocks.stream }))
vi.mock('./runtime/launch', () => ({
  stripElectronRunAsNode: () => ({ FIXTURE_ONLY: '1' }),
  serveOrcaApp: vi.fn()
}))
import { runNativeAgentStdio } from './native-agent-stdio'
const reference = {
  launchId: '10000000-0000-4000-8000-000000000001',
  generation: '20000000-0000-4000-8000-000000000001'
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture(stdout: Writable = new PassThrough()) {
  const client = new RuntimeClient('/fixture-only', 60_000, null, null, '/fixture-only/orca')
  const call = vi.spyOn(client, 'call')
  call.mockResolvedValue(okFixture('fixture', reference))
  const io = {
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    signals: new EventEmitter()
  }
  return {
    call,
    io,
    client,
    run: () => runNativeAgentStdio(client, '/fake/native', ['-p', 'fixture'], io)
  }
}
afterEach(() => vi.clearAllMocks())
it('preserves channels and ACKs only after local writes finish, with listener cleanup', async () => {
  const f = fixture(),
    out: Buffer[] = [],
    err: Buffer[] = []
  f.io.stdout.on('data', (chunk) => out.push(chunk))
  f.io.stderr.on('data', (chunk) => err.push(chunk))
  mocks.stream.mockImplementation(async (_client, _method, _params, frame) => {
    await frame({
      type: 'native-stdio-output',
      sequence: 1,
      channel: 'stdout',
      bytes: Buffer.from([0, 255]).toString('base64')
    })
    await frame({
      type: 'native-stdio-output',
      sequence: 2,
      channel: 'stderr',
      bytes: Buffer.from('error').toString('base64')
    })
    await frame({ type: 'native-stdio-exit', code: 7 })
  })
  expect(await f.run()).toBe(7)
  expect(Buffer.compare(Buffer.concat(out), Buffer.from([0, 255]))).toBe(0)
  expect(Buffer.concat(err).toString()).toBe('error')
  expect(
    f.call.mock.calls
      .filter(([method]) => method === 'accounts.controlNativeCliStdio')
      .map(([, params]) => params)
  ).toEqual([
    { ...reference, sequence: 1 },
    { ...reference, sequence: 2 }
  ])
  await turn()
  expect(f.io.stdout.listenerCount('error')).toBe(0)
  expect(f.io.stdin.listenerCount('data')).toBe(0)
  expect(f.io.signals.eventNames()).toEqual([])
})
it('contains output EPIPE, aborts attachment and never leaks raw sink error text', async () => {
  const stdout = new Writable({
    write(_bytes, _encoding, callback) {
      callback(new Error('private sink path'))
    }
  })
  const f = fixture(stdout)
  let signal: AbortSignal | undefined
  mocks.stream.mockImplementation(async (_client, _method, _params, frame, abort) => {
    signal = abort
    await frame({ type: 'native-stdio-output', sequence: 1, channel: 'stdout', bytes: 'eA==' })
  })
  await expect(f.run()).rejects.toThrow(/Native CLI local (input\/output|output) stream failed/)
  await turn()
  expect(signal?.aborted).toBe(true)
  expect(stdout.listenerCount('error')).toBe(0)
  expect(
    f.call.mock.calls.filter(([method]) => method === 'accounts.controlNativeCliStdio')
  ).toHaveLength(0)
})
it('contains input errors while the start RPC is pending and removes all temporary listeners', async () => {
  const f = fixture()
  f.call.mockImplementation(
    async (_method, _params, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true
        })
      })
  )
  const running = f.run()
  const rejected = expect(running).rejects.toThrow('Native CLI local input/output stream failed.')
  f.io.stdin.emit('error', new Error('private input error'))
  await rejected
  await turn()
  expect(mocks.stream).not.toHaveBeenCalled()
  expect(f.io.stdin.listenerCount('error')).toBe(0)
})
it('waits for the final whole input chunk before forwarding EOF', async () => {
  const f = fixture(),
    commands: unknown[] = []
  let release = () => {},
    ended = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const eof = new Promise<void>((resolve) => {
    ended = resolve
  })
  f.call.mockImplementation(async (method, params) => {
    if (method === 'accounts.controlNativeCliStdio') {
      commands.push(params)
      if (commands.length === 1) {
        await blocked
      }
      if (params && typeof params === 'object' && 'eof' in params) {
        ended()
      }
    }
    return okFixture('fixture', reference)
  })
  mocks.stream.mockImplementation(async (_client, _method, _params, frame) => {
    f.io.stdin.end(Buffer.alloc(64 * 1024, 120))
    await vi.waitFor(() => expect(commands).toHaveLength(1))
    release()
    await eof
    await frame({ type: 'native-stdio-exit', code: 0 })
  })
  expect(await f.run()).toBe(0)
  expect(
    commands.map((value) =>
      value && typeof value === 'object' && 'eof' in value ? 'eof' : 'input'
    )
  ).toEqual(['input', 'input', 'eof'])
})
it('forwards a signal through RPC without sending an OS signal from the test', async () => {
  const f = fixture()
  mocks.stream.mockImplementation(async (_client, _method, _params, frame) => {
    f.io.signals.emit('SIGTERM')
    await Promise.resolve()
    await frame({ type: 'native-stdio-exit', code: 143 })
  })
  expect(await f.run()).toBe(143)
  expect(
    f.call.mock.calls
      .filter(([method]) => method === 'accounts.controlNativeCliStdio')
      .map(([, params]) => params)
  ).toEqual([{ ...reference, sequence: 0, signal: 'SIGTERM' }])
})

it('second signal aborts blocked local output and retains its error sink until write settles', async () => {
  let finish: (error?: Error | null) => void = () => {}
  const stdout = new Writable({
    write(_bytes, _encoding, callback) {
      finish = callback
    }
  })
  const f = fixture(stdout)
  let started = false
  mocks.stream.mockImplementation(async (_client, _method, _params, frame, signal) => {
    const consuming = frame({
      type: 'native-stdio-output',
      sequence: 1,
      channel: 'stdout',
      bytes: 'eA=='
    })
    // The real transport also keeps an observer on a pending consumer after abort.
    void Promise.resolve(consuming).catch(() => {})
    started = true
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('detached')), { once: true })
    )
  })
  const running = f.run()
  const rejected = expect(running).rejects.toThrow('detached')
  await vi.waitFor(() => expect(started).toBe(true))
  f.io.signals.emit('SIGINT')
  await Promise.resolve()
  f.io.signals.emit('SIGTERM')
  await rejected
  await turn()
  expect(stdout.listenerCount('error')).toBe(1)
  expect(
    f.call.mock.calls
      .filter(([method]) => method === 'accounts.controlNativeCliStdio')
      .map(([, params]) => params)
  ).toEqual([{ ...reference, sequence: 0, signal: 'SIGINT' }])
  finish(new Error('private late EPIPE'))
  await turn()
  await turn()
  expect(stdout.listenerCount('error')).toBe(0)
})
