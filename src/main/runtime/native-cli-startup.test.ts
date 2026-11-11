import { afterEach, expect, it, vi } from 'vitest'
import { NativeCliStartup } from './native-cli-startup'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import {
  trackRunningAgentLaunchPane,
  resolveAgentLaunchPaneVerdict,
  agentLaunchPaneStartupVerdict,
  holdAgentLaunchPaneStartup,
  resetAgentLaunchPanesForTests
} from '../agent-launch/agent-launch-pane-attachment'

afterEach(() => {
  vi.useRealTimers()
  resetAgentLaunchPanesForTests()
})
const pane = { worktreeId: 'folder:synthetic', paneKey: 'tab:leaf' }

it.each(['early-tab', 'shipped-spawn'] as const)(
  'holds %s proceed until the exact initial prepare refuses',
  async () => {
    const running = trackRunningAgentLaunchPane(pane)
    const startup = new NativeCliStartup('raw:incarnation', 'synthetic-token', 'codex')
    holdAgentLaunchPaneStartup(pane, startup.settled)
    const attachment = resolveAgentLaunchPaneVerdict(pane, () => true)
    const reports = agentLaunchPaneStartupVerdict(pane)
    let attached = false
    void attachment?.then(() => {
      attached = true
    })
    running.agentBound()
    running.finish({ kind: 'proceed' })
    await Promise.resolve()
    expect(attached).toBe(false)
    expect(startup.begin('initial')).toBe(true)
    expect(startup.refuse('copied-id', new NativeCliControlError('config_conflict'))).toBe(false)
    expect(startup.refuse('initial', new NativeCliControlError('config_conflict'))).toBe(true)
    await expect(attachment).resolves.toEqual({
      kind: 'not-started',
      code: 'native_cli_config_conflict'
    })
    await expect(reports).resolves.toEqual({
      kind: 'not-started',
      code: 'native_cli_config_conflict'
    })
    running.finish({ kind: 'proceed' })
    await expect(resolveAgentLaunchPaneVerdict(pane, () => true)).resolves.toMatchObject({
      kind: 'not-started'
    })
  }
)

it.each(['prepared', 'ready'] as const)(
  'permanently disarms refusal after %s with no assignment',
  async () => {
    const startup = new NativeCliStartup('raw', 'token', 'codex')
    expect(startup.begin('first')).toBe(true)
    startup.finish('prepared')
    expect(startup.begin('nested')).toBe(false)
    expect(startup.refuse('first', new NativeCliControlError('config_conflict'))).toBe(false)
    expect(startup.refusal).toBeNull()
    await expect(startup.settled).resolves.toEqual({ kind: 'proceed' })
  }
)

it('settles old/no-V2 starts honestly within the bounded legacy deadline', async () => {
  vi.useFakeTimers()
  const startup = new NativeCliStartup('raw', 'token', 'codex')
  await vi.advanceTimersByTimeAsync(30_000)
  await expect(startup.settled).resolves.toEqual({ kind: 'unconfirmed' })
  expect(startup.begin('late')).toBe(false)
  expect(startup.refusal).toBeNull()
})
