import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import {
  nativeCliTerminalBindings,
  noteNativeCliTerminalRotation
} from './native-cli-terminal-bindings'
import { writeNativeCliTerminalInput } from './native-cli-terminal-input'

function fixture() {
  let incarnationId = 'a'
  const writes: string[] = []
  const host = {
    getDriver: () => ({ kind: 'desktop' }),
    refreshRemoteDesktopViewer: vi.fn(async () => true),
    resolveTerminalPane: () => ({
      handle: `term-${incarnationId}`,
      ptyId: `pty-${incarnationId}`,
      incarnationId,
      connected: true
    }),
    sendTerminal: vi.fn(async (_handle, action, options) => {
      options.reserveWrite(`pty-${incarnationId}`)
      writes.push(action.text)
      return { accepted: true }
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The synthetic host implements the complete input/rotation binding surface, without starting any process.
  const runtime = host as unknown as OrcaRuntimeService
  const binding = {
    launchId: 'launch',
    paneKey: 'pane',
    worktreeId: 'workspace',
    incarnationId: 'a',
    rotating: false,
    waiters: new Set<() => void>(),
    env: {},
    inputTail: Promise.resolve(),
    pendingInputChars: 0,
    cols: 80,
    rows: 24,
    inputReady: true
  }
  nativeCliTerminalBindings(runtime).set('launch', binding)
  return {
    runtime,
    host,
    binding,
    writes,
    replace: () => {
      incarnationId = 'b'
    }
  }
}
it('holds keys during replacement and sends them once to the verified replacement', async () => {
  const f = fixture()
  noteNativeCliTerminalRotation(f.runtime, 'pane', true)
  const pending = writeNativeCliTerminalInput(f.runtime, 'launch', 'new input\r')
  await Promise.resolve()
  expect(f.host.sendTerminal).not.toHaveBeenCalled()
  f.replace()
  noteNativeCliTerminalRotation(f.runtime, 'pane', false)
  f.binding.inputReady = true
  for (const notify of f.binding.waiters) {
    notify()
  }
  await pending
  expect(f.writes).toEqual(['new input\r'])
  expect(f.host.sendTerminal).toHaveBeenCalledWith('term-b', expect.anything(), expect.anything())
})
it('refuses an unrelated pane replacement without sending keys', async () => {
  const f = fixture()
  f.replace()
  await expect(writeNativeCliTerminalInput(f.runtime, 'launch', 'draft')).rejects.toThrow(
    'ownership changed'
  )
  expect(f.writes).toEqual([])
})
it('never retries a write after provider acceptance becomes unverifiable', async () => {
  const f = fixture()
  f.host.sendTerminal.mockImplementation(async (_handle, action, options) => {
    options.reserveWrite('pty-a')
    f.writes.push(action.text)
    return { accepted: false }
  })
  await expect(writeNativeCliTerminalInput(f.runtime, 'launch', 'one action\r')).rejects.toThrow(
    'unverifiable'
  )
  expect(f.writes).toEqual(['one action\r'])
  expect(f.host.sendTerminal).toHaveBeenCalledOnce()
})
it('rejects an oversized chunk before taking a queue slot or writing', async () => {
  const f = fixture()
  await expect(writeNativeCliTerminalInput(f.runtime, 'launch', 'x'.repeat(4097))).rejects.toThrow(
    'too large'
  )
  expect(f.binding.pendingInputChars).toBe(0)
  expect(f.writes).toEqual([])
})
it('never carries a reply to an old terminal query into the replacement CLI', async () => {
  const f = fixture()
  noteNativeCliTerminalRotation(f.runtime, 'pane', true)
  f.replace()
  noteNativeCliTerminalRotation(f.runtime, 'pane', false)
  f.binding.inputReady = true
  await writeNativeCliTerminalInput(f.runtime, 'launch', '\x1b[1;1R', 'a')
  expect(f.writes).toEqual([])
})
it('cancels a queued chunk on detach before the provider write boundary', async () => {
  const f = fixture()
  const controller = new AbortController()
  noteNativeCliTerminalRotation(f.runtime, 'pane', true)
  const pending = writeNativeCliTerminalInput(f.runtime, 'launch', 'draft', 'a', controller.signal)
  const rejected = expect(pending).rejects.toThrow('detached before delivery')
  await Promise.resolve()
  controller.abort()
  await rejected
  expect(f.writes).toEqual([])
  expect(f.binding.waiters.size).toBe(0)
  expect(f.binding.pendingInputChars).toBe(0)
})
