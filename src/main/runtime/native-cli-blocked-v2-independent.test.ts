import { afterEach, expect, it, vi } from 'vitest'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import { nativeCliStartupFixture } from './native-cli-startup-fixture'
import { prepareNativeCliStartup } from './native-cli-startup-prepare'
import { buildPtyTerminalWaitBlockedResult } from './terminal-wait-results'
import { makeTuiIdleLeaf } from './tui-idle-wait-test-harness'
import { RuntimeTerminalIdlePolls } from './terminal/wait/terminal-idle-polls'
import { RuntimeTerminalWait } from './terminal/wait/terminal-wait'
import { RuntimeTerminalWaiterRegistry } from './terminal/wait/terminal-waiter-registry'

const prepare = vi.hoisted(() => vi.fn())
vi.mock('./native-cli-account-launch', () => ({ prepareNativeCliAccountLaunch: prepare }))

afterEach(() => prepare.mockReset())

it('retains V2 refusal after a blocked readiness result from the actual waiter registry', async () => {
  const f = nativeCliStartupFixture()
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
      getLivePty: () => ({ pty: f.pty }),
      getLiveLeaf: () => ({ leaf: makeTuiIdleLeaf() }),
      startVisibleReadProbe: vi.fn()
    },
    waiters,
    polls
  )
  const cleanup = vi.spyOn(f.db, 'releaseUnconsumedNativeCliStartup')
  const report = vi.spyOn(f.runtime, 'reportAgentLaunchPaneVerdict')
  let rejectPreparation: ((error: Error) => void) | undefined
  prepare.mockImplementation(
    () =>
      new Promise<never>((_resolve, reject) => {
        rejectPreparation = reject
      })
  )

  try {
    const pending = wait.wait('term_synthetic', {
      condition: 'tui-idle',
      launchReadiness: true
    })
    const waiter = [...(waiters.get('term_synthetic') ?? [])][0]
    if (!waiter) {
      throw new Error('Expected a registered launch readiness waiter')
    }

    const preparation = prepareNativeCliStartup(f.runtime, f.request)
    const refused = expect(preparation).rejects.toMatchObject({
      code: 'native_cli_config_conflict'
    })
    expect(prepare).toHaveBeenCalledOnce()
    expect(f.startup.state).toBe('preparing')

    waiters.resolve(
      waiter,
      buildPtyTerminalWaitBlockedResult(
        'term_synthetic',
        'tui-idle',
        f.pty,
        'agent-interactive-prompt'
      )
    )
    await expect(pending).resolves.toMatchObject({
      condition: 'tui-idle',
      status: 'running',
      satisfied: false,
      blockedReason: 'agent-interactive-prompt'
    })
    expect(f.startup.state).toBe('preparing')
    expect(f.startup.refusal).toBeNull()
    expect(report).not.toHaveBeenCalled()

    if (!rejectPreparation) {
      throw new Error('Expected pending V2 preparation')
    }
    rejectPreparation(new NativeCliControlError('config_conflict'))
    await refused
    await expect(f.startup.settled).resolves.toEqual({
      kind: 'not-started',
      code: 'native_cli_config_conflict'
    })
    expect(f.startup.state).toBe('refused')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: f.pty.worktreeId }), {
      kind: 'not-started',
      code: 'native_cli_config_conflict'
    })
    await expect(
      wait.wait('term_synthetic', { condition: 'tui-idle', launchReadiness: true })
    ).rejects.toMatchObject({ code: 'native_cli_config_conflict' })
  } finally {
    waiters.rejectHandle('term_synthetic', 'test_cleanup')
    f.dispose()
  }
})
