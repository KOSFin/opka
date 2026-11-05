import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { attachNativeAgentTerminal } from './native-agent-terminal'
const hooks = vi.hoisted(() => ({ stream: vi.fn() }))
vi.mock('./runtime/stream-request', () => ({ streamRuntimeRequest: hooks.stream }))
const restore: (() => void)[] = []
afterEach(() => {
  for (const cleanup of restore.splice(0).toReversed()) {
    cleanup()
  }
  vi.resetAllMocks()
})
class Input extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(raw: boolean) {
    this.isRaw = raw
    return this
  }
}
class Output extends PassThrough {
  isTTY = true
  columns = 100
  rows = 40
}
function fixture() {
  const stdin = new Input()
  const stdout = new Output()
  for (const [name, value] of [
    ['stdin', stdin],
    ['stdout', stdout]
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(process, name)
    if (!descriptor) {
      throw new Error('Missing stdio descriptor')
    }
    Object.defineProperty(process, name, { configurable: true, value })
    restore.push(() => Object.defineProperty(process, name, descriptor))
  }
  const client = {
    call: vi.fn().mockResolvedValue({ ok: true, result: { accepted: true } }),
    userDataPath: '/synthetic',
    isRemote: false
  }
  return { stdin, stdout, client }
}
it('forwards SIGINT as native input and restores raw mode and resize listeners after exit', async () => {
  const f = fixture()
  const signals = process.listenerCount('SIGINT')
  hooks.stream.mockImplementation(async (_client, _method, _params, emit) => {
    await emit({ type: 'native-cli-pane', handle: 'term-native', incarnationId: 'one' })
    await emit({ type: 'scrollback', serialized: '\x1b[31mnative', lines: [] })
    expect(f.stdin.isRaw).toBe(true)
    process.emit('SIGINT')
    f.stdout.emit('resize')
    await emit({ type: 'native-cli-exit', code: 17 })
  })
  expect(await attachNativeAgentTerminal(f.client, 'synthetic')).toBe(17)
  expect(f.client.call).toHaveBeenCalledWith(
    'accounts.writeNativeCliTerminal',
    { launchId: 'synthetic', incarnationId: 'one', text: '\x03' },
    expect.anything()
  )
  expect(f.client.call).toHaveBeenCalledWith(
    'accounts.resizeNativeCliTerminal',
    { launchId: 'synthetic', cols: 100, rows: 40 },
    expect.anything()
  )
  expect(f.stdin.isRaw).toBe(false)
  expect(f.stdout.listenerCount('resize')).toBe(0)
  expect(f.stdin.listenerCount('data')).toBe(0)
  expect(process.listenerCount('SIGINT')).toBe(signals)
})
it('restores raw mode on loss of contact without claiming or killing the child', async () => {
  const f = fixture()
  hooks.stream.mockImplementation(async (_client, _method, _params, emit) => {
    await emit({ type: 'native-cli-pane', handle: 'term-native', incarnationId: 'one' })
    throw new Error('transport lost')
  })
  await expect(attachNativeAgentTerminal(f.client, 'synthetic')).rejects.toThrow(
    'execution is unverifiable'
  )
  expect(f.stdin.isRaw).toBe(false)
  expect(f.client.call).not.toHaveBeenCalled()
})
it('retains the source incarnation of keys queued before a replacement frame', async () => {
  const f = fixture()
  hooks.stream.mockImplementation(async (_client, _method, _params, emit) => {
    void emit({ type: 'native-cli-pane', handle: 'term-a', incarnationId: 'a' })
    f.stdin.emit('data', '\x1b[1;1R')
    void emit({ type: 'native-cli-pane', handle: 'term-b', incarnationId: 'b' })
    await emit({ type: 'native-cli-exit', code: 0 })
  })
  expect(await attachNativeAgentTerminal(f.client, 'synthetic')).toBe(0)
  expect(f.client.call).toHaveBeenCalledWith(
    'accounts.writeNativeCliTerminal',
    { launchId: 'synthetic', incarnationId: 'a', text: '\x1b[1;1R' },
    expect.anything()
  )
})
it('reports reattachment information when accepted input becomes unverifiable', async () => {
  const f = fixture()
  f.client.call.mockRejectedValue(new Error('write settlement unavailable'))
  hooks.stream.mockImplementation(async (_client, _method, _params, emit) => {
    await emit({ type: 'native-cli-pane', handle: 'term-a', incarnationId: 'a' })
    process.emit('SIGINT')
  })
  await expect(attachNativeAgentTerminal(f.client, 'synthetic')).rejects.toThrow(
    'agent native-attach synthetic'
  )
  expect(f.stdin.isRaw).toBe(false)
})
