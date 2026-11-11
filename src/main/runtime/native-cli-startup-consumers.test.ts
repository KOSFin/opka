import { afterEach, expect, it, vi } from 'vitest'
import { NativeCliStartup } from './native-cli-startup'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import { trackEarlyAgentLaunchTab } from './rpc/methods/agent-launch-tab-publication'
import { endPaneAgentLaunch } from '../ipc/pty/ipc/spawn-agent-launch-end'
import type { PtyIpcSpawnState } from '../ipc/pty/ipc/spawn-state'
import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import {
  holdAgentLaunchPaneStartup,
  trackRunningAgentLaunchPane,
  resetAgentLaunchPanesForTests
} from '../agent-launch/agent-launch-pane-attachment'
import { nativeCliStartupFixture } from './native-cli-startup-fixture'
import { createNativeCliStartupReadiness } from './native-cli-startup-readiness'
const layout = vi.hoisted(() => ({ main: false }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layout.main
  }
}))
afterEach(() => resetAgentLaunchPanesForTests())

it.each([false, true])(
  'keeps shipped-spawn refusal against parent proceed with main layout=%s',
  async (main) => {
    layout.main = main
    const f = nativeCliStartupFixture()
    const pane = { worktreeId: f.pty.worktreeId, paneKey: f.request.parentTerminal.paneKey }
    const address = {
      worktreeId: pane.worktreeId,
      tabId: 'tab_fixture',
      leafId: '77777777-7777-4777-8777-777777777777'
    }
    const running = trackRunningAgentLaunchPane(pane)
    holdAgentLaunchPaneStartup(pane, f.startup.settled)
    vi.spyOn(f.runtime, 'getTerminalHandleForPaneKey').mockReturnValue(
      f.request.parentTerminal.terminalHandle
    )
    const events: unknown[] = []
    f.runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn(),
      agentLaunchPaneVerdict: (event) => {
        events.push(event)
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: endPaneAgentLaunch reads and clears only paneAgentLaunch for a successful synthetic provider spawn.
    const state = {
      paneAgentLaunch: {
        runtime: f.runtime,
        address,
        paneKey: pane.paneKey,
        running,
        dispatched: true,
        refuseIfClosed: () => {}
      }
    } as unknown as PtyIpcSpawnState
    try {
      endPaneAgentLaunch(state, { started: true })
      expect(events).toEqual([])
      f.startup.begin('initial')
      f.startup.refuse('initial', new NativeCliControlError('config_conflict'))
      await f.startup.settled
      await Promise.resolve()
      expect(events).toEqual([
        { ...address, verdict: { kind: 'not-started', code: 'native_cli_config_conflict' } }
      ])
      f.runtime.reportAgentLaunchPaneVerdict(address, { kind: 'proceed' })
      await Promise.resolve()
      expect(events).not.toContainEqual({ ...address, verdict: { kind: 'proceed' } })
    } finally {
      f.dispose()
    }
  }
)

it('holds the actual early-tab finish path until the wrapper preparation outcome', async () => {
  const pane = { worktreeId: 'folder:synthetic', paneKey: 'tab:leaf' }
  const running = trackRunningAgentLaunchPane(pane)
  const startup = new NativeCliStartup('raw', 'token', 'codex')
  holdAgentLaunchPaneStartup(pane, startup.settled)
  const finish = vi.fn((verdict) => running.finish(verdict))
  const early = trackEarlyAgentLaunchTab({
    paneKey: pane.paneKey,
    publishing: Promise.resolve({
      tabId: 'tab_fixture',
      created: true,
      placement: { groupId: 'synthetic-group' }
    }),
    finishRunning: finish,
    agentBound: () => running.agentBound(),
    paneIsLive: () => true,
    closedByUser: () => false,
    report: vi.fn()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: surfacePublished reads only the terminal outcome kind and paneKey.
  early.surfacePublished({
    outcome: { kind: 'terminal', paneKey: pane.paneKey }
  } as AgentLaunchResult)
  early.finish()
  expect(startup.state).toBe('pending')
  startup.begin('initial')
  startup.refuse('initial', new NativeCliControlError('config_conflict'))
  await expect(startup.settled).resolves.toMatchObject({ kind: 'not-started' })
})

it('rejects active and late composer waits with the same fixed receipt and cleans listeners', async () => {
  const startup = new NativeCliStartup('raw', 'token', 'codex')
  const readiness = createNativeCliStartupReadiness(startup)
  const wait = readiness.wait(
    new Promise<null>((resolve) =>
      readiness.stop.signal.addEventListener('abort', () => resolve(null))
    )
  )
  const rejected = expect(wait).rejects.toMatchObject({ code: 'native_cli_config_conflict' })
  startup.begin('initial')
  startup.refuse('initial', new NativeCliControlError('config_conflict'))
  await rejected
  expect(() => createNativeCliStartupReadiness(startup)).toThrow(NativeCliControlError)
})
