import { expect, it, vi } from 'vitest'
import { RuntimeTerminalWait } from './terminal/wait/terminal-wait'
import { RuntimeTerminalIdlePolls } from './terminal/wait/terminal-idle-polls'
import { RuntimeTerminalWaiterRegistry } from './terminal/wait/terminal-waiter-registry'
import { makeTuiIdleLeaf, makeTuiIdlePty } from './tui-idle-wait-test-harness'
import { NativeCliStartup } from './native-cli-startup'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import { buildPtyTerminalWaitResult } from './terminal-wait-results'

it('rejects current and late initial readiness while retaining ordinary and exit waits', async () => {
  const pty = makeTuiIdlePty()
  pty.incarnationId = 'raw-synthetic'
  pty.launchToken = 'synthetic'
  pty.launchIncarnationId = pty.incarnationId
  pty.launchAgent = 'codex'
  if (!pty.incarnationId) {
    throw new Error('Fixture must have a raw incarnation')
  }
  const startup = new NativeCliStartup(pty.incarnationId, 'synthetic', 'codex')
  pty.nativeCliStartup = startup
  const waiters = new RuntimeTerminalWaiterRegistry()
  const deps = {
    getTabTitle: () => null,
    getAdoptedPtyIdleStatus: () => null,
    getPaneAgent: () => 'codex' as const,
    getFirstPartyAgentStatus: () => null,
    readScreenLines: () => null,
    readVisibleScreen: () => null,
    quiescenceMs: 3000
  }
  const polls = new RuntimeTerminalIdlePolls({
    ...deps,
    intervalMs: 2000,
    getForegroundProcess: async () => null,
    hasCommandPainted: () => true,
    getLiveLeaf: (leaf) => leaf,
    resolve: (waiter, result) => waiters.resolve(waiter, result)
  })
  const wait = new RuntimeTerminalWait(
    {
      ...deps,
      defaultTimeoutMs: 60_000,
      getLivePty: () => ({ pty }),
      getLiveLeaf: () => ({ leaf: makeTuiIdleLeaf() }),
      startVisibleReadProbe: vi.fn()
    },
    waiters,
    polls
  )
  const current = wait.wait('term', { condition: 'tui-idle', launchReadiness: true })
  const refusal = expect(current).rejects.toMatchObject({ code: 'native_cli_config_conflict' })
  const exit = wait.wait('term', { condition: 'exit' })
  const exitRefusal = expect(exit).rejects.toThrow('test_cleanup')
  const ordinary = wait.wait('term', { condition: 'tui-idle' })
  const ordinaryRefusal = expect(ordinary).rejects.toThrow('test_cleanup')
  startup.begin('initial')
  startup.refuse('initial', new NativeCliControlError('config_conflict'))
  await refusal
  await expect(
    wait.wait('term', { condition: 'tui-idle', launchReadiness: true })
  ).rejects.toMatchObject({ code: 'native_cli_config_conflict' })
  expect([...(waiters.get('term') ?? [])].map((entry) => entry.condition)).toEqual([
    'exit',
    'tui-idle'
  ])
  waiters.rejectHandle('term', 'test_cleanup')
  await Promise.all([exitRefusal, ordinaryRefusal])
})

it('prepares the current PTY generation when launch readiness resolves', async () => {
  const pty = makeTuiIdlePty()
  pty.incarnationId = 'raw-synthetic'
  pty.launchToken = 'synthetic'
  pty.launchIncarnationId = pty.incarnationId
  pty.launchAgent = 'codex'
  const startup = new NativeCliStartup('raw-synthetic', 'synthetic', 'codex')
  pty.nativeCliStartup = startup
  const waiters = new RuntimeTerminalWaiterRegistry()
  const deps = {
    getTabTitle: () => null,
    getAdoptedPtyIdleStatus: () => null,
    getPaneAgent: () => 'codex' as const,
    getFirstPartyAgentStatus: () => null,
    readScreenLines: () => null,
    readVisibleScreen: () => null,
    quiescenceMs: 3000
  }
  const polls = new RuntimeTerminalIdlePolls({
    ...deps,
    intervalMs: 2000,
    getForegroundProcess: async () => null,
    hasCommandPainted: () => true,
    getLiveLeaf: (leaf) => leaf,
    resolve: (waiter, result) => waiters.resolve(waiter, result)
  })
  const wait = new RuntimeTerminalWait(
    {
      ...deps,
      defaultTimeoutMs: 60_000,
      getLivePty: () => ({ pty }),
      getLiveLeaf: () => ({ leaf: makeTuiIdleLeaf() }),
      startVisibleReadProbe: vi.fn()
    },
    waiters,
    polls
  )
  const pending = wait.wait('term', { condition: 'tui-idle', launchReadiness: true })
  const waiter = [...(waiters.get('term') ?? [])][0]
  if (!waiter) {
    throw new Error('Launch readiness waiter was not registered')
  }
  expect(startup.begin('initial')).toBe(true)
  waiters.resolve(waiter, buildPtyTerminalWaitResult('term', 'tui-idle', pty))
  await pending
  expect(startup.state).toBe('prepared')
  expect(startup.refuse('initial', new NativeCliControlError('config_conflict'))).toBe(false)
})

it('does not prepare a replacement PTY generation from an older readiness waiter', async () => {
  const pty = makeTuiIdlePty()
  pty.incarnationId = 'raw-old'
  pty.launchIncarnationId = 'raw-old'
  pty.launchToken = 'old-token'
  pty.launchAgent = 'codex'
  const oldStartup = new NativeCliStartup('raw-old', 'old-token', 'codex')
  pty.nativeCliStartup = oldStartup
  let currentPty = pty
  const waiters = new RuntimeTerminalWaiterRegistry()
  const deps = {
    getTabTitle: () => null,
    getAdoptedPtyIdleStatus: () => null,
    getPaneAgent: () => 'codex' as const,
    getFirstPartyAgentStatus: () => null,
    readScreenLines: () => null,
    readVisibleScreen: () => null,
    quiescenceMs: 3000
  }
  const polls = new RuntimeTerminalIdlePolls({
    ...deps,
    intervalMs: 2000,
    getForegroundProcess: async () => null,
    hasCommandPainted: () => true,
    getLiveLeaf: (leaf) => leaf,
    resolve: (waiter, result) => waiters.resolve(waiter, result)
  })
  const wait = new RuntimeTerminalWait(
    {
      ...deps,
      defaultTimeoutMs: 60_000,
      getLivePty: () => ({ pty: currentPty }),
      getLiveLeaf: () => ({ leaf: makeTuiIdleLeaf() }),
      startVisibleReadProbe: vi.fn()
    },
    waiters,
    polls
  )
  try {
    const pending = wait.wait('term', { condition: 'tui-idle', launchReadiness: true })
    const waiter = [...(waiters.get('term') ?? [])][0]
    if (!waiter) {
      throw new Error('Launch readiness waiter was not registered')
    }
    expect(oldStartup.begin('initial')).toBe(true)
    const nextStartup = new NativeCliStartup('raw-next', 'next-token', 'codex')
    const nextPty = makeTuiIdlePty({
      incarnationId: 'raw-next',
      launchIncarnationId: 'raw-next',
      launchToken: 'next-token',
      launchAgent: 'codex'
    })
    nextPty.nativeCliStartup = nextStartup
    currentPty = nextPty
    expect(nextStartup.begin('next')).toBe(true)

    waiters.resolve(waiter, buildPtyTerminalWaitResult('term', 'tui-idle', pty))
    await expect(pending).resolves.toMatchObject({ satisfied: true })
    expect(oldStartup.state).toBe('preparing')
    expect(nextStartup.state).toBe('preparing')
    expect(nextStartup.refuse('next', new NativeCliControlError('config_conflict'))).toBe(true)
    await expect(nextStartup.settled).resolves.toMatchObject({
      kind: 'not-started',
      code: 'native_cli_config_conflict'
    })
  } finally {
    oldStartup.finish('unconfirmed')
    currentPty.nativeCliStartup?.finish('unconfirmed')
    waiters.rejectHandle('term', 'test_cleanup')
  }
})
