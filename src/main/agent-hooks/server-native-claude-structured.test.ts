import { expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import type { NativeCliStdioOwner } from '../runtime/native-cli-stdio-owner'
import type { NativeClaudeCanonicalHook } from '../../shared/native-claude-canonical-hook'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
const nativeId = '10000000-0000-4000-8000-000000000001'
const promptId = '20000000-0000-4000-8000-000000000001'
function owner(id = 'owned-stdio-session'): NativeCliStdioOwner {
  return {
    sessionId: id,
    fence: 7,
    subject: makeStructuredAgentStatusSubject(
      {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'floating',
        workspaceKind: 'folder'
      },
      id
    ),
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 100, spawnToken: 'fixture-token' }
  }
}
function fixture() {
  const server = new AgentHookServer(),
    owned = owner()
  const emit = (
    event: NativeClaudeCanonicalHook['event'],
    fields: Partial<NativeClaudeCanonicalHook> = {}
  ) =>
    server.ingestNativeClaudeStructuredHook(owned, {
      nativeOrigin: 'engine',
      event,
      sessionId: nativeId,
      ...fields
    })
  const read = () => server.readNativeClaudeStructuredLead(owned.subject)
  const start = () => {
    emit('SessionStart', { source: 'startup' })
    emit('UserPromptSubmit', { promptId })
  }
  return { server, owned, emit, read, start }
}
it('publishes genuine main metadata once canonically and never inserts a legacy row', () => {
  const f = fixture()
  f.start()
  expect(f.read()?.row).toMatchObject({
    state: 'working',
    mainAgent: { state: 'working' },
    providerSession: { id: nativeId }
  })
  f.emit('Stop', { promptId, backgroundTasks: [] })
  expect(f.read()?.row).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
  expect(f.read()?.lead.nativeHook).toMatchObject({
    event: 'Stop',
    promptId,
    backgroundTasksComplete: true,
    sessionCronsComplete: true
  })
  expect(f.server.getCanonicalStatusSnapshot().parents).toHaveLength(1)
  expect(f.server._getStateForTests().lastStatusByPaneKey.size).toBe(0)
  expect(f.read()?.row.prompt).toBe('')
})
it('keeps private structured work current when public hooks are disabled', () => {
  const f = fixture()
  f.server.setStatusHooksEnabled(false)
  f.start()
  expect(f.read()?.row).toMatchObject({ state: 'working', structuredHost: 'owned' })
  expect(f.server._getStateForTests().lastStatusByPaneKey.size).toBe(0)
})
it.each(['plugin', 'unverifiable'] as const)(
  'refuses %s origin before it can mint a native Start or status',
  (nativeOrigin) => {
    const f = fixture()
    expect(
      f.server.ingestNativeClaudeStructuredHook(f.owned, {
        nativeOrigin,
        event: 'SessionStart',
        sessionId: nativeId,
        source: 'startup'
      })
    ).toBe(false)
    expect(f.read()).toBeNull()
    expect(f.server._getStateForTests().claudeLeadStateByPaneKey.size).toBe(0)
    expect(f.server.getCanonicalStatusSnapshot().parents).toHaveLength(0)
  }
)
it('preserves exact done lead plus real child/cron work through the canonical projection', () => {
  const f = fixture()
  f.start()
  f.emit('Stop', {
    promptId,
    backgroundTasks: [{ id: 'native-agent-1', type: 'agent', status: 'running' }],
    sessionCrons: ['native-cron-1']
  })
  expect(f.read()?.row).toMatchObject({
    state: 'working',
    mainAgent: { state: 'done' }
  })
  expect(f.read()?.row.workingMode).toBeUndefined()
  expect(
    f.server
      .getStructuredChildWork(f.owned.subject)
      .map((row) => row.kind)
      .sort()
  ).toEqual(['agent', 'monitor'])
  expect(f.server._getStateForTests().lastStatusByPaneKey.size).toBe(0)
})
it('holds unknown/truncated inventory without inventing a native child handle', () => {
  const f = fixture()
  f.start()
  f.emit('Stop', { promptId, backgroundTasksTruncated: true, sessionCronsTruncated: true })
  expect(f.read()?.row).toMatchObject({
    state: 'working',
    workingMode: 'monitoring',
    mainAgent: { state: 'done' }
  })
  expect(f.read()?.lead.nativeHook).toMatchObject({
    backgroundTasksComplete: false,
    sessionCronsComplete: false
  })
  expect(f.server.getStructuredChildWork(f.owned.subject)).toHaveLength(0)
})
it('does not let child failure replace the lead Stop or certify a lead quota failure', () => {
  const f = fixture()
  f.start()
  f.emit('Stop', { promptId, backgroundTasks: [] })
  f.emit('SubagentStart', { agentId: 'native-child' })
  f.emit('StopFailure', { promptId, agentId: 'native-child', error: 'rate_limit' })
  expect(f.read()?.lead.nativeHook?.event).toBe('Stop')
  expect(f.read()?.lead.nativeFailure).toBeUndefined()
})
it('records a real lead failure and clears it only at a true new SessionStart', () => {
  const f = fixture()
  f.start()
  f.emit('StopFailure', { promptId, error: 'rate_limit', backgroundTasks: [] })
  expect(f.read()?.lead.nativeFailure).toMatchObject({ sessionId: nativeId, promptId })
  f.emit('SessionStart', { source: 'resume' })
  expect(f.read()?.lead.nativeHook?.event).toBe('SessionStart')
  expect(f.read()?.lead.nativeFailure).toBeUndefined()
})
it('rejects a foreign native session before mutating existing lead facts', () => {
  const f = fixture()
  f.start()
  const before = f.read()?.lead.nativeHook
  expect(
    f.emit('SessionStart', { source: 'startup', sessionId: '30000000-0000-4000-8000-000000000001' })
  ).toBe(false)
  expect(f.read()?.lead.nativeHook).toBe(before)
})
it('refuses payload text and oversized metadata without retaining it', () => {
  const f = fixture()
  expect(
    f.server.ingestNativeClaudeStructuredHook(f.owned, {
      nativeOrigin: 'engine',
      event: 'UserPromptSubmit',
      sessionId: nativeId,
      promptId,
      prompt: 'must-not-retain'
    })
  ).toBe(false)
  expect(
    f.emit('Stop', {
      backgroundTasks: Array.from({ length: 65 }, () => ({
        id: 'a',
        type: 'agent',
        status: 'running'
      }))
    })
  ).toBe(false)
  expect(f.server.getCanonicalStatusSnapshot().parents).toHaveLength(0)
})
it('retires only its structured subject and fold caches after host-proven completion', () => {
  const f = fixture()
  f.start()
  const other = owner('another-real-lease')
  f.server.ingestNativeClaudeStructuredHook(other, {
    nativeOrigin: 'engine',
    event: 'UserPromptSubmit',
    sessionId: nativeId,
    promptId
  })
  f.server.retireNativeClaudeStructuredHook(f.owned.subject)
  expect(f.read()).toBeNull()
  expect(f.server.readNativeClaudeStructuredLead(other.subject)?.row.state).toBe('working')
  expect(f.server._getStateForTests().claudeLeadStateByPaneKey.size).toBe(1)
  expect(f.server._getStateForTests().lastStatusByPaneKey.size).toBe(0)
})
