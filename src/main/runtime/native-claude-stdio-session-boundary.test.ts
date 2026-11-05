import { expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import type { NativeClaudeCoverageObservation } from '../../shared/native-claude-coverage'
import type { NativeClaudeCanonicalHook } from '../../shared/native-claude-canonical-hook'
import type { NativeCliStdioOwner } from './native-cli-stdio-owner'
import { createNativeClaudeStdioSessionBoundary } from './native-claude-stdio-session-boundary'
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
const launchId = '11111111-1111-4111-8111-111111111111'
const root = '22222222-2222-4222-8222-222222222222'
const generation = '33333333-3333-4333-8333-333333333333'
const promptId = '44444444-4444-4444-8444-444444444444'
function fixture() {
  const hooks = new AgentHookServer()
  const owner: NativeCliStdioOwner = {
    sessionId: 'native_stdio_fixture',
    fence: 1,
    subject: makeStructuredAgentStatusSubject(
      {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'floating',
        workspaceKind: 'folder'
      },
      'native_stdio_fixture'
    ),
    process: { hostId: 'local', pid: 42, processStartTimeMs: 100, spawnToken: 'private-fixture' }
  }
  let observation: NativeCliStdioOwner | null = owner
  let strict: NativeCliStdioOwner | null = owner
  let enabled = true
  const commit = vi.fn(async () => {})
  const boundary = createNativeClaudeStdioSessionBoundary({
    runtime: {},
    launchId,
    startedAt: 1,
    isCurrent: () => true,
    isEnabled: () => enabled,
    managedCoverage: true,
    hooks,
    owners: {
      wait: async () => observation,
      observe: () => observation,
      strict: () => strict,
      commit
    }
  })
  let sequence = 0
  const emit = (event: NativeClaudeCoverageObservation, sessionId = root) =>
    boundary.observe({
      launchId,
      capability: 'x'.repeat(64),
      sessionId,
      generation,
      sequence: ++sequence,
      observation: event
    })
  const hook = (
    event: NativeClaudeCanonicalHook['event'],
    fields: Partial<NativeClaudeCanonicalHook> = {}
  ) =>
    emit({
      kind: 'canonical-hook',
      hook: { nativeOrigin: 'engine', event, sessionId: root, ...fields }
    })
  const start = () => hook('SessionStart', { source: 'startup' })
  const finish = async () => {
    await hook('UserPromptSubmit', { promptId })
    await emit({ kind: 'request-start', id: 'actual-request', mainTurnId: 'actual-turn' })
    await emit({ kind: 'request-end', id: 'actual-request' })
    await hook('Stop', { promptId, backgroundTasks: [] })
    return emit({ kind: 'complete-stop', promptId })
  }
  return {
    hooks,
    owner,
    boundary,
    emit,
    hook,
    start,
    finish,
    commit,
    setStrict: (value: boolean) => {
      strict = value ? owner : null
    },
    setObservation: (value: boolean) => {
      observation = value ? owner : null
    },
    setEnabled: (value: boolean) => {
      enabled = value
    },
    request: (event: 'prompt' | 'stop' = 'prompt', sessionId = root) => ({
      launchId,
      capability: 'x'.repeat(64),
      sessionId,
      promptId,
      event
    })
  }
}
it('uses actual canonical structured ingress and commits only the first provider UUID', async () => {
  const f = fixture()
  await f.start()
  expect(f.commit).toHaveBeenCalledTimes(1)
  expect(f.commit).toHaveBeenCalledWith(expect.anything(), launchId, root)
  expect(f.hooks.getCanonicalStatusSnapshot().parents).toHaveLength(1)
  expect(f.hooks._getStateForTests().lastStatusByPaneKey.size).toBe(0)
  expect((await f.finish()).sealedStop).toBe(true)
  expect(f.boundary.readBoundary().canSwitch()).toBe(true)
  expect(f.boundary.readCompletedSuccessfully()).toBe(false)
  f.boundary.dispose()
})
it('keeps observation-owned current work while strict switching proof or hooks are unavailable', async () => {
  const f = fixture()
  await f.start()
  await f.finish()
  expect(f.boundary.isSwitchOwnershipCurrent()).toBe(true)
  f.setStrict(false)
  expect(f.boundary.isSwitchOwnershipCurrent()).toBe(false)
  await expect(f.boundary.accept(f.request())).resolves.toBeUndefined()
  expect(f.boundary.readOwner()).not.toBeNull()
  expect(f.boundary.readBoundary().canSwitch()).toBe(false)
  f.setStrict(true)
  f.setEnabled(false)
  expect(f.boundary.isSwitchOwnershipCurrent()).toBe(false)
  expect((await f.emit({ kind: 'draft', active: false })).ack.healthy).toBe(true)
  expect(f.boundary.readBoundary().canSwitch()).toBe(false)
  f.boundary.dispose()
})
it('pins changed native root without overwriting old canonical child scope or committing a second UUID', async () => {
  const f = fixture()
  await f.start()
  await f.hook('SubagentStart', { agentId: 'actual-old-child' })
  const nextRoot = '55555555-5555-4555-8555-555555555555'
  expect((await f.emit({ kind: 'draft', active: false }, nextRoot)).ack.healthy).toBe(false)
  await f.emit(
    {
      kind: 'canonical-hook',
      hook: { nativeOrigin: 'engine', event: 'SessionStart', source: 'clear', sessionId: nextRoot }
    },
    nextRoot
  )
  expect(f.boundary.readOwner()?.sessionId).toBe(nextRoot)
  await expect(f.boundary.accept(f.request('prompt', nextRoot))).resolves.toBeUndefined()
  expect(f.boundary.isCurrentAccountOnly(f.request('prompt', nextRoot))).toBe(true)
  expect(f.boundary.isCurrentAccountOnly(f.request('stop', nextRoot))).toBe(false)
  expect(f.commit).toHaveBeenCalledTimes(1)
  expect(f.hooks.readNativeClaudeStructuredLead(f.owner.subject)?.row.providerSession?.id).toBe(
    root
  )
  expect(f.hooks.getStructuredChildWork(f.owner.subject)).toHaveLength(1)
  expect(f.boundary.readBoundary().canSwitch()).toBe(false)
  expect(f.boundary.canRevokeAndDrain()).toBe(false)
  f.boundary.dispose()
})
it('rechecks observation authority after awaited provider commit before ingesting any canonical state', async () => {
  const f = fixture()
  f.commit.mockImplementation(async () => {
    f.setObservation(false)
  })
  await expect(f.start()).rejects.toThrow('ownership changed')
  expect(f.hooks.getCanonicalStatusSnapshot().parents).toHaveLength(0)
  f.boundary.dispose()
})
it('does not clear canonical work on dispose or contact loss; explicit proof retirement uses captured subject', async () => {
  const f = fixture()
  await f.start()
  await f.hook('UserPromptSubmit', { promptId })
  f.setObservation(false)
  f.boundary.dispose()
  expect(f.hooks.getCanonicalStatusSnapshot().parents).toHaveLength(1)
  f.boundary.retireCanonical()
  expect(f.hooks.getCanonicalStatusSnapshot().parents).toHaveLength(0)
  expect(f.hooks._getStateForTests().claudeLeadStateByPaneKey.size).toBe(0)
})
it('rejects admission after capability disposal and pre-aborted owner wait', async () => {
  const f = fixture()
  await f.start()
  f.boundary.dispose()
  await expect(f.boundary.accept(f.request())).rejects.toThrow('ownership')
  await expect(f.boundary.waitForOwner(AbortSignal.abort())).rejects.toThrow()
})

it('commits no provider identity from an unqualified frame before genuine engine SessionStart', async () => {
  const f = fixture()
  expect((await f.emit({ kind: 'draft', active: false })).ack.healthy).toBe(false)
  expect(f.commit).not.toHaveBeenCalled()
  expect(f.hooks.getCanonicalStatusSnapshot().parents).toHaveLength(0)
  await f.start()
  expect(f.commit).toHaveBeenCalledTimes(1)
  f.boundary.dispose()
})
it('consumes each logical successful Stop once across private and legacy callbacks', async () => {
  const f = fixture()
  await f.start()
  await f.finish()
  const first = f.boundary.readBoundary()
  expect(first.canSwitch()).toBe(true)
  first.onBoundaryAccepted()
  expect(first.canSwitch()).toBe(false)
  expect(f.boundary.readIdleBoundary().canSwitch()).toBe(false)
  await expect(f.boundary.accept(f.request('stop'))).resolves.toBeUndefined()
  expect(f.boundary.readCompletedSuccessfully()).toBe(false)
  f.boundary.dispose()
})
it('pins a failed identity commit without breaking current-account work or retrying the commit', async () => {
  const f = fixture()
  f.commit.mockRejectedValue(new Error('private store failure'))
  expect((await f.start()).ack.healthy).toBe(false)
  await expect(f.boundary.accept(f.request())).resolves.toBeUndefined()
  expect(f.boundary.isCurrentAccountOnly(f.request())).toBe(true)
  expect((await f.start()).ack.healthy).toBe(false)
  expect(f.commit).toHaveBeenCalledTimes(1)
  expect(f.boundary.readBoundary().canSwitch()).toBe(false)
  expect(f.hooks.getCanonicalStatusSnapshot().parents).toHaveLength(1)
  f.boundary.dispose()
})

it.each(['answer', 'aborted', 'refusal', 'error'] as const)(
  'classifies only a genuine sealed late lead turn-end answer as success (%s)',
  async (reason) => {
    const f = fixture()
    await f.start()
    await f.finish()
    expect(f.boundary.readCompletedSuccessfully()).toBe(false)
    await f.emit({ kind: 'turn-end', id: 'actual-turn', reason, agents: [] })
    expect(f.boundary.readCompletedSuccessfully()).toBe(reason === 'answer')
    f.boundary.dispose()
  }
)
it('does not classify a child or foreign turn-end as the sealed lead answer', async () => {
  const f = fixture()
  await f.start()
  await f.finish()
  await f.emit({
    kind: 'turn-end',
    id: 'actual-turn',
    agentId: 'actual-child',
    reason: 'answer',
    agents: []
  })
  expect(f.boundary.readCompletedSuccessfully()).toBe(false)
  await f.emit({ kind: 'turn-end', id: 'different-turn', reason: 'answer', agents: [] })
  expect(f.boundary.readCompletedSuccessfully()).toBe(false)
  f.boundary.dispose()
})
