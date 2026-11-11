import { expect, it, vi } from 'vitest'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import { NativeCliStartup } from './native-cli-startup'
import { buildPtyTerminalWaitBlockedResult } from './terminal-wait-results'
import { makeTuiIdleLeaf, makeTuiIdlePty } from './tui-idle-wait-test-harness'
import { RuntimeTerminalIdlePolls } from './terminal/wait/terminal-idle-polls'
import { RuntimeTerminalWait } from './terminal/wait/terminal-wait'
import { RuntimeTerminalWaiterRegistry } from './terminal/wait/terminal-waiter-registry'

it('keeps initial startup eligible for typed refusal when a readiness wait resolves blocked', async () => {
  const pty = makeTuiIdlePty({
    incarnationId: 'raw-synthetic',
    launchIncarnationId: 'raw-synthetic',
    launchToken: 'synthetic-token',
    launchAgent: 'codex'
  })
  const startup = new NativeCliStartup('raw-synthetic', 'synthetic-token', 'codex')
  pty.nativeCliStartup = startup
  const waiters = new RuntimeTerminalWaiterRegistry()
  const evidence = {
    getTabTitle: () => null,
    getAdoptedPtyIdleStatus: () => null,
    getPaneAgent: () => 'codex' as const,
    getFirstPartyAgentStatus: () => null,
    readScreenLines: () => null,
    readVisibleScreen: () => null,
    quiescenceMs: 3000
  }
  const polls = new RuntimeTerminalIdlePolls({
    ...evidence,
    intervalMs: 2000,
    getForegroundProcess: async () => null,
    hasCommandPainted: () => true,
    getLiveLeaf: (leaf) => leaf,
    resolve: (waiter, result) => waiters.resolve(waiter, result)
  })
  const wait = new RuntimeTerminalWait(
    {
      ...evidence,
      defaultTimeoutMs: 60_000,
      getLivePty: () => ({ pty }),
      getLiveLeaf: () => ({ leaf: makeTuiIdleLeaf() }),
      startVisibleReadProbe: vi.fn()
    },
    waiters,
    polls
  )
  try {
    const pending = wait.wait('term_synthetic', { condition: 'tui-idle', launchReadiness: true })
    const waiter = [...(waiters.get('term_synthetic') ?? [])][0]
    if (!waiter) {
      throw new Error('Launch readiness waiter was not registered')
    }
    expect(startup.begin('initial')).toBe(true)
    waiters.resolve(
      waiter,
      buildPtyTerminalWaitBlockedResult(
        'term_synthetic',
        'tui-idle',
        pty,
        'agent-interactive-prompt'
      )
    )
    await expect(pending).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-interactive-prompt'
    })
    expect(startup.state).toBe('preparing')
    expect(startup.refuse('initial', new NativeCliControlError('config_conflict'))).toBe(true)
    await expect(startup.settled).resolves.toMatchObject({
      kind: 'not-started',
      code: 'native_cli_config_conflict'
    })
  } finally {
    startup.finish('unconfirmed')
    waiters.rejectHandle('term_synthetic', 'test_cleanup')
  }
})
