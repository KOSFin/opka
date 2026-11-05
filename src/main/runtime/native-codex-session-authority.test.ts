import { expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
const proof = vi.hoisted(() => ({
  registered: true,
  inventory: 'settled',
  pty: true,
  transcriptDone: true,
  requestsIdle: true,
  hooksEnabled: true
}))
vi.mock('./native-codex-routing-ownership', () => ({
  isNativeCodexRoutingLaunch: () => proof.registered
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    readNativeCodexChildInventory: () => ({ status: proof.inventory }),
    registerNativeCodexInventorySource: () => ({
      bindRoot: () => {},
      read: () => ({ status: proof.inventory }),
      readTurn: () => proof.transcriptDone && proof.inventory === 'settled',
      readBoundaryTurn: () => proof.transcriptDone && proof.inventory === 'settled',
      prepare: async () => {},
      dispose: () => {}
    })
  }
}))
import { createNativeCodexSessionAuthority } from './native-codex-session-authority'
function fixture(external = false) {
  proof.registered = true
  proof.inventory = 'settled'
  proof.pty = true
  proof.transcriptDone = true
  proof.requestsIdle = true
  proof.hooksEnabled = true
  const row: AgentStatusIpcPayload = {
    paneKey: 'pane',
    worktreeId: 'workspace',
    connectionId: null,
    receivedAt: 2000,
    stateStartedAt: 2000,
    state: 'working',
    prompt: '',
    agentType: 'codex',
    providerSession: { key: 'session_id', id: 'root' },
    observation: {
      origin: 'hook',
      kind: 'transition',
      authorityId: 'host',
      incarnation: 1,
      revision: 2,
      observedAt: 2000
    }
  }
  const owner = { paneKey: 'pane', ptyId: 'pty', incarnationId: 'incarnation' }
  const runtime = { agentTransitions: { latestRow: () => row } }
  const authority = createNativeCodexSessionAuthority(
    runtime,
    'registered-launch',
    () => (!external && proof.pty ? owner : null),
    '/synthetic-host-home',
    () => proof.requestsIdle,
    () => proof.hooksEnabled
  )
  return { authority, row }
}
it('uses the owned native root session without inventing an execution identity', () => {
  const { authority } = fixture()
  expect(authority.readNativeOwner()).toBeNull()
  authority.bindRoot('root')
  expect(authority.readNativeOwner()).toEqual({
    paneKey: 'pane',
    ptyId: 'pty',
    incarnationId: 'incarnation',
    launchId: 'registered-launch',
    sessionId: 'root'
  })
  expect(authority.canReplaceRejectedRequest()).toBe(true)
  proof.registered = false
  expect(authority.readNativeOwner()).toBeNull()
  expect(authority.canReplaceRejectedRequest()).toBe(false)
})
it('pins a child session and missing or active descendant inventories', () => {
  const { authority, row } = fixture()
  authority.bindRoot('root')
  row.providerSession = { key: 'session_id', id: 'child' }
  expect(authority.readNativeOwner()).toBeNull()
  expect(authority.canReplaceRejectedRequest()).toBe(false)
  row.providerSession = { key: 'session_id', id: 'root' }
  proof.inventory = 'live'
  expect(authority.canReplaceRejectedRequest()).toBe(false)
  proof.inventory = 'unverifiable'
  expect(authority.canReplaceRejectedRequest()).toBe(false)
})

it('never substitutes transcript completion for a known PTY canonical Stop or lost terminal proof', () => {
  const { authority } = fixture()
  authority.bindRoot('root')
  authority.onRootTurnAccepted('root', 'turn')
  expect(
    authority.boundary({ canSwitch: () => false, onBoundaryAccepted: () => {} }).canSwitch()
  ).toBe(false)
  proof.pty = false
  expect(
    authority.boundary({ canSwitch: () => false, onBoundaryAccepted: () => {} }).canSwitch()
  ).toBe(false)
  expect(authority.canReplaceRejectedRequest()).toBe(false)
})
it('uses owned transcript completion for a genuinely external CLI with no fabricated pane', () => {
  const { authority } = fixture(true)
  authority.bindRoot('root')
  authority.onRootTurnAccepted('root', 'turn')
  proof.transcriptDone = false
  expect(authority.canReplaceRejectedRequest()).toBe(true)
  expect(authority.readNativeOwner()).toBeNull()
  expect(
    authority.boundary({ canSwitch: () => false, onBoundaryAccepted: () => {} }).canSwitch()
  ).toBe(false)
  proof.transcriptDone = true
  expect(
    authority.boundary({ canSwitch: () => false, onBoundaryAccepted: () => {} }).canSwitch()
  ).toBe(true)
  expect(authority.canReplaceRejectedRequest()).toBe(true)
  proof.inventory = 'live'
  expect(authority.canReplaceRejectedRequest()).toBe(false)
})

it('retains an old native Stop only for its actual launch/PTY/source with no accepted HTTP work', () => {
  const { authority, row } = fixture()
  authority.bindRoot('root')
  authority.onRootTurnAccepted('root', 'turn')
  const held = {
    paneKey: 'pane',
    ptyId: 'pty',
    incarnationId: 'incarnation',
    launchId: 'registered-launch',
    sessionId: 'root'
  }
  row.providerSession = { key: 'session_id', id: 'new-root' }
  expect(authority.readNativeOwner()).toBeNull()
  expect(authority.readRetainedNativeBoundary(held)).toBe(true)
  proof.requestsIdle = false
  expect(authority.readRetainedNativeBoundary(held)).toBe(false)
  proof.requestsIdle = true
  proof.transcriptDone = false
  expect(authority.readRetainedNativeBoundary(held)).toBe(false)
  proof.transcriptDone = true
  expect(authority.readRetainedNativeBoundary({ ...held, incarnationId: 'foreign' })).toBe(false)
})

it.each([false, true])(
  'pins existing native sessions when status hooks are disabled (external=%s)',
  async (external) => {
    const { authority } = fixture(external)
    authority.bindRoot('root')
    authority.onRootTurnAccepted('root', 'turn')
    const boundary = authority.boundary({ canSwitch: () => true, onBoundaryAccepted: () => {} })
    expect(boundary.canSwitch()).toBe(true)
    expect(authority.canReplaceRejectedRequest()).toBe(true)
    proof.hooksEnabled = false
    expect(boundary.canSwitch()).toBe(false)
    expect(authority.readNativeOwner()).toBeNull()
    expect(authority.canReplaceRejectedRequest()).toBe(false)
    expect(authority.areRetainedTurnsSettled()).toBe(false)
    await expect(authority.prepareQuotaRetry(new AbortController().signal)).rejects.toThrow(
      'requires enabled agent status hooks'
    )
  }
)
