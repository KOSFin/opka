import { expect, it, vi } from 'vitest'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { AgentChildWorkView } from '../../shared/agent-status-child-work-view'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import {
  createNativeCliTurnBoundary,
  type NativeCliTurnOwner,
  type NativeCliSessionOwner
} from './native-cli-turn-boundary'
vi.mock('./pty-account-pool-child-inventory', () => ({ readPtyAccountPoolChildren: () => [] }))
function fixture(
  expectedSessionId?: () => string | null,
  useNative = false,
  readRetainedNativeBoundary?: (owner: NativeCliSessionOwner) => boolean
) {
  const row: AgentStatusIpcPayload = {
    paneKey: 'pane',
    executionId: 'execution',
    worktreeId: 'workspace',
    connectionId: null,
    receivedAt: 2000,
    stateStartedAt: 2000,
    state: 'done',
    prompt: '',
    agentType: 'codex',
    turnStartedAt: 1500,
    turnCompletedAt: 2000,
    mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 2000 },
    providerSession: { key: 'session_id', id: 'session' },
    observation: {
      origin: 'hook',
      kind: 'transition',
      authorityId: 'host',
      incarnation: 1,
      revision: 2,
      observedAt: 2000
    }
  }
  const state: {
    row: AgentStatusIpcPayload
    owner: NativeCliTurnOwner
    children: AgentChildWorkView[] | undefined
    now: number
    nativeOwner: NativeCliSessionOwner | null
    nativeChildren: 'settled' | 'live' | 'unverifiable' | undefined
  } = {
    row,
    owner: {
      paneKey: 'pane',
      ptyId: 'pty',
      incarnationId: 'incarnation',
      executionId: 'execution'
    },
    children: [],
    now: 2500,
    nativeOwner: {
      paneKey: 'pane',
      ptyId: 'pty',
      incarnationId: 'incarnation',
      launchId: 'owned-launch',
      sessionId: 'session'
    },
    nativeChildren: 'settled'
  }
  let observe = (_change: AgentPaneChange) => {}
  const release = vi.fn()
  const boundary = createNativeCliTurnBoundary({
    provider: 'codex',
    launchStartedAt: 1000,
    transitions: {
      subscribe: (listener) => {
        observe = listener
        return release
      },
      latestRow: () => state.row
    },
    readOwner: () => state.owner,
    ...(readRetainedNativeBoundary ? { readRetainedNativeBoundary } : {}),
    ...(useNative
      ? {
          readNativeOwner: () => state.nativeOwner,
          readNativeChildren: () =>
            state.nativeChildren ? { status: state.nativeChildren } : undefined
        }
      : {}),
    ...(expectedSessionId ? { expectedSessionId } : {}),
    readChildren: () => state.children,
    now: () => state.now
  })
  const notify = (kind: 'observed' | 'seeded' = 'observed') =>
    observe({
      kind,
      paneKey: 'pane',
      workspace: { worktreeId: 'workspace', sshHostId: null },
      phase: 'rest',
      at: state.now
    })
  return { state, boundary, release, notify }
}
it('refuses child Stop before the proven root session can establish the physical execution anchor', () => {
  const f = fixture(() => 'session')
  f.state.row.providerSession = { key: 'session_id', id: 'child-session' }
  f.state.row.executionId = 'child-execution'
  f.state.owner.executionId = 'child-execution'
  f.notify()
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.row.providerSession = { key: 'session_id', id: 'session' }
  f.state.row.executionId = 'execution'
  f.state.owner.executionId = 'execution'
  f.notify()
  expect(f.boundary.canSwitch()).toBe(true)
})
it('pins the account while root protocol identity is unknown', () => {
  const f = fixture(() => null)
  f.notify()
  expect(f.boundary.canSwitch()).toBe(false)
  expect(f.boundary.snapshot().version).toBeNull()
})
it('holds no startup/replayed permission and snapshots do not consume a fresh canonical Stop', () => {
  const f = fixture()
  expect(f.boundary.canSwitch()).toBe(false)
  f.notify('seeded')
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.row.isReplay = true
  f.notify()
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.row.isReplay = false
  f.notify()
  const first = f.boundary.snapshot()
  expect(first.canSwitch()).toBe(true)
  expect(f.boundary.snapshot().version).toBe(first.version)
  expect(f.boundary.canSwitch()).toBe(true)
})
it('retains one completed permit after the next UserPromptSubmit reports working', () => {
  const f = fixture()
  f.notify()
  f.state.row.state = 'working'
  f.state.row.turnStartedAt = 2100
  f.state.row.turnCompletedAt = undefined
  f.state.row.mainAgent = { state: 'working', stateStartedAt: 2100 }
  f.notify()
  const held = f.boundary.snapshot()
  expect(held.canSwitch()).toBe(true)
  held.onBoundaryAccepted()
  expect(f.boundary.canSwitch()).toBe(false)
  held.onBoundaryAccepted()
  f.notify()
  expect(f.boundary.canSwitch()).toBe(false)
})
it('never consumes a newer Stop when acknowledging a previously held admission snapshot', () => {
  const f = fixture()
  f.notify()
  const old = f.boundary.snapshot()
  f.state.row.turnStartedAt = 2500
  f.state.row.turnCompletedAt = 3000
  f.state.row.mainAgent = { state: 'done', outcome: 'success', stateStartedAt: 3000 }
  f.state.now = 3500
  f.notify()
  old.onBoundaryAccepted()
  expect(old.canSwitch()).toBe(false)
  const next = f.boundary.snapshot()
  expect(next.version).not.toBe(old.version)
  expect(next.canSwitch()).toBe(true)
  next.onBoundaryAccepted()
  expect(f.boundary.canSwitch()).toBe(false)
})
it('requires canonical settled children, including an idle child whose membership remains live', () => {
  const f = fixture()
  f.state.children = undefined
  f.notify()
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.children = [
    {
      id: 'child',
      kind: 'agent',
      state: 'idle',
      membership: 'live',
      firstObservedAt: 1500,
      observedAt: 2000,
      stoppable: true,
      invocation: { invocationId: 'child-turn', generation: 1 }
    }
  ]
  f.notify()
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.children = []
  f.notify()
  expect(f.boundary.canSwitch()).toBe(true)
})
it('refuses another physical execution or provider session instead of adopting it', () => {
  const f = fixture()
  f.notify()
  f.state.owner.incarnationId = 'replacement'
  expect(f.boundary.canSwitch()).toBe(false)
  f.notify()
  expect(f.boundary.canSwitch()).toBe(false)
  const g = fixture()
  g.notify()
  g.state.row.providerSession = { key: 'session_id', id: 'different-chat' }
  expect(g.boundary.canSwitch()).toBe(false)
})
it('does not treat late work on the old turn as a new user-root boundary', () => {
  const f = fixture()
  f.notify()
  f.state.row.state = 'working'
  expect(f.boundary.canSwitch()).toBe(false)
})
it('keeps an unused completed permission across idle time but retires it on disposal', () => {
  const f = fixture()
  f.notify()
  f.state.now = 1000000
  expect(f.boundary.canSwitch()).toBe(true)
  const held = f.boundary.snapshot()
  f.boundary.dispose()
  expect(held.canSwitch()).toBe(false)
  expect(f.release).toHaveBeenCalledOnce()
})

it('accepts a registered native root without execution ID only with verified settled inventory', () => {
  const f = fixture(() => 'session', true)
  delete f.state.row.executionId
  f.state.children = undefined
  f.notify()
  expect(f.boundary.canSwitch()).toBe(true)
  f.state.nativeChildren = 'live'
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.nativeChildren = 'unverifiable'
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.nativeChildren = undefined
  expect(f.boundary.canSwitch()).toBe(false)
})
it('keeps generic execution callers pinned without execution ID or canonical child inventory', () => {
  const f = fixture(() => 'session')
  delete f.state.row.executionId
  f.notify()
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.row.executionId = 'execution'
  f.state.children = undefined
  f.notify()
  expect(f.boundary.canSwitch()).toBe(false)
})
it('rejects absent native owners, child sessions and changed physical incarnations', () => {
  const f = fixture(() => 'session', true)
  delete f.state.row.executionId
  f.state.row.providerSession = { key: 'session_id', id: 'child' }
  f.notify()
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.row.providerSession = { key: 'session_id', id: 'session' }
  f.notify()
  expect(f.boundary.canSwitch()).toBe(true)
  f.state.nativeOwner = {
    paneKey: 'pane',
    ptyId: 'pty',
    incarnationId: 'other',
    launchId: 'owned-launch',
    sessionId: 'session'
  }
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.nativeOwner = null
  expect(f.boundary.canSwitch()).toBe(false)
})

it('retains one old-root Stop across a new SessionStart only with fresh owned source proof', () => {
  let proven = true
  let expected = 'session'
  const check = vi.fn(() => proven)
  const f = fixture(() => expected, true, check)
  f.notify()
  const old = f.boundary.snapshot()
  const firstOwner = f.state.nativeOwner
  f.state.row = {
    ...f.state.row,
    providerSession: { key: 'session_id', id: 'new-root' },
    sessionBoundary: true
  }
  f.state.nativeOwner = null
  f.notify()
  expect(old.canSwitch()).toBe(true)
  expect(check).toHaveBeenCalledWith(firstOwner)
  proven = false
  expect(old.canSwitch()).toBe(false)
  proven = true
  old.onBoundaryAccepted()
  expect(old.canSwitch()).toBe(false)
  expected = 'new-root'
  if (!firstOwner) {
    throw new Error('Missing original owner')
  }
  f.state.nativeOwner = { ...firstOwner, sessionId: expected }
  f.state.row = {
    ...f.state.row,
    sessionBoundary: false,
    turnCompletedAt: 2200,
    stateStartedAt: 2200,
    receivedAt: 2200,
    mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 2200 }
  }
  f.notify()
  expect(f.boundary.canSwitch()).toBe(true)
})
it('does not retain another root without explicit registered native-source authority', () => {
  const f = fixture(() => 'session', true)
  f.notify()
  f.state.row.providerSession = { key: 'session_id', id: 'new-root' }
  f.state.nativeOwner = null
  f.notify()
  expect(f.boundary.canSwitch()).toBe(false)
})

it('reanchors a newly accepted root after an unsafe transition without granting its old Stop', () => {
  let expected = 'session'
  const f = fixture(() => expected, true)
  f.notify()
  const old = f.boundary.snapshot()
  expected = 'second-root'
  const owner = f.state.nativeOwner
  if (!owner) {
    throw new Error('Missing native owner')
  }
  f.state.nativeOwner = { ...owner, sessionId: expected }
  f.state.row.providerSession = { key: 'session_id', id: expected }
  f.boundary.rootBound()
  expect(old.canSwitch()).toBe(false)
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.row.turnCompletedAt = 2300
  f.state.row.receivedAt = 2300
  f.state.row.mainAgent = { state: 'done', outcome: 'success', stateStartedAt: 2300 }
  f.notify()
  expect(f.boundary.canSwitch()).toBe(true)
})

it('retains a strictly idle native Stop for later saved policies after its one-use turn permit was consumed', () => {
  const f = fixture(() => 'session', true)
  f.notify()
  const turn = f.boundary.snapshot(),
    idle = f.boundary.idleSnapshot()
  turn.onBoundaryAccepted()
  expect(turn.canSwitch()).toBe(false)
  expect(idle.canSwitch()).toBe(true)
  f.state.now = 1000000
  expect(idle.canSwitch()).toBe(true)
  f.state.row.state = 'working'
  f.state.row.turnStartedAt = 3000
  expect(idle.canSwitch()).toBe(false)
  f.boundary.rootBound()
  expect(idle.canSwitch()).toBe(false)
})

it('rechecks the exact observed native Stop after private inventory certification without emitting a status transition', () => {
  const f = fixture(() => 'session', true)
  f.state.nativeChildren = 'unverifiable'
  f.notify()
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.nativeChildren = 'settled'
  f.boundary.refreshNativeEvidence()
  expect(f.boundary.canSwitch()).toBe(true)
  f.boundary.snapshot().onBoundaryAccepted()
  f.boundary.refreshNativeEvidence()
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.row.state = 'working'
  f.state.row.mainAgent = { state: 'working', stateStartedAt: 3000 }
  f.boundary.refreshNativeEvidence()
  expect(f.boundary.canSwitch()).toBe(false)
})

it('certifies the genuine held Stop after a newer prompt and delayed transcript EOF', () => {
  const f = fixture(() => 'session', true)
  f.state.nativeChildren = 'unverifiable'
  f.notify()
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.row = {
    ...f.state.row,
    state: 'working',
    turnStartedAt: 2100,
    turnCompletedAt: undefined,
    mainAgent: { state: 'working', stateStartedAt: 2100 }
  }
  f.notify()
  f.boundary.refreshNativeEvidence()
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.nativeChildren = 'settled'
  f.boundary.refreshNativeEvidence()
  const permit = f.boundary.snapshot()
  expect(permit.canSwitch()).toBe(true)
  permit.onBoundaryAccepted()
  f.boundary.refreshNativeEvidence()
  expect(f.boundary.canSwitch()).toBe(false)
})

it('never certifies a delayed Stop after its native owner changed', () => {
  const f = fixture(() => 'session', true)
  f.state.nativeChildren = 'unverifiable'
  f.notify()
  const owner = f.state.nativeOwner
  if (!owner) {
    throw new Error('Missing native owner')
  }
  f.state.nativeOwner = { ...owner, incarnationId: 'other' }
  f.state.row.state = 'working'
  f.state.row.turnStartedAt = 2100
  f.state.row.mainAgent = { state: 'working', stateStartedAt: 2100 }
  f.state.nativeChildren = 'settled'
  f.boundary.refreshNativeEvidence()
  expect(f.boundary.canSwitch()).toBe(false)
  f.state.nativeOwner = owner
  f.boundary.refreshNativeEvidence()
  expect(f.boundary.canSwitch()).toBe(false)
})

it('keeps captured Stop provenance across an idle pause without renewing its timestamp', () => {
  const f = fixture(() => 'session', true)
  f.state.nativeChildren = 'unverifiable'
  f.notify()
  f.state.now = 1000000
  f.state.row = {
    ...f.state.row,
    state: 'working',
    turnStartedAt: 999999,
    turnCompletedAt: undefined,
    mainAgent: { state: 'working', stateStartedAt: 999999 }
  }
  f.notify()
  f.state.nativeChildren = 'settled'
  f.boundary.refreshNativeEvidence()
  expect(f.boundary.canSwitch()).toBe(true)
})

it.each(['seeded', 'replay', 'interrupted', 'root-bound'] as const)(
  'discards pending Stop evidence after %s',
  (invalidated) => {
    const f = fixture(() => 'session', true)
    f.state.nativeChildren = 'unverifiable'
    f.notify()
    if (invalidated === 'root-bound') {
      f.boundary.rootBound()
    } else if (invalidated === 'seeded') {
      f.notify('seeded')
    } else {
      if (invalidated === 'replay') {
        f.state.row.isReplay = true
      } else {
        f.state.row.interrupted = true
      }
      f.notify()
    }
    f.state.row = {
      ...f.state.row,
      isReplay: false,
      interrupted: false,
      state: 'working',
      turnStartedAt: 2100,
      turnCompletedAt: undefined,
      mainAgent: { state: 'working', stateStartedAt: 2100 }
    }
    f.state.nativeChildren = 'settled'
    f.boundary.refreshNativeEvidence()
    expect(f.boundary.canSwitch()).toBe(false)
  }
)
