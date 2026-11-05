import { afterEach, expect, it } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
const session = '00000000-0000-4000-8000-000000000001',
  prompt = '00000000-0000-4000-8000-000000000002'
afterEach(() => {
  _internals.resetCachesForTests()
})
it('reads the exact native prompt identity from the canonical local hook receipt without another status map', async () => {
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  try {
    await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        session_id: session,
        prompt_id: prompt,
        prompt: 'synthetic task'
      }),
      '/hook/claude'
    )
    const row = server.getStatusSnapshotForPane(PANE)[0]
    expect(server.readNativeClaudePromptId(row)).toBe(prompt)
    expect(server.readNativeClaudePromptId({ ...row, receivedAt: row.receivedAt - 1 })).toBeNull()
    expect(server.readNativeClaudePromptId({ ...row, isReplay: true })).toBeNull()
    expect(server.readNativeClaudePromptId({ ...row, connectionId: 'foreign-host' })).toBeNull()
    await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'Stop',
        session_id: session,
        prompt_id: prompt,
        background_tasks: []
      }),
      '/hook/claude'
    )
    const stopped = server.getStatusSnapshotForPane(PANE)[0]
    expect(stopped.claudeNativeBoundaryInventory).toBe('complete')
    expect(server.readNativeClaudePromptId(stopped)).toBe(prompt)
  } finally {
    server.stop()
  }
})
it('does not borrow a child prompt identity for a main native callback', async () => {
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  try {
    await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        session_id: session,
        prompt_id: prompt,
        prompt: 'synthetic task'
      }),
      '/hook/claude'
    )
    await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'SubagentStop',
        session_id: session,
        prompt_id: prompt,
        agent_id: 'synthetic-child',
        background_tasks: []
      }),
      '/hook/claude'
    )
    const row = server.getStatusSnapshotForPane(PANE)[0]
    expect(server.readNativeClaudePromptId(row)).toBeNull()
    expect(row.claudeNativeBoundaryInventory).toBeUndefined()
  } finally {
    server.stop()
  }
})

it('uses an exact complete lead Stop for ordinary native child inventory without an execution id', async () => {
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  try {
    await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        session_id: session,
        prompt_id: prompt,
        prompt: 'synthetic task'
      })
    )
    await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'Stop',
        session_id: session,
        prompt_id: prompt,
        background_tasks: [],
        session_crons: []
      })
    )
    const stopped = server.getStatusSnapshotForPane(PANE)[0]
    expect(stopped.executionId).toBeUndefined()
    expect(server.readNativeClaudeChildInventory(stopped)).toEqual({ status: 'settled' })
    expect(
      server.readNativeClaudeChildInventory({ ...stopped, receivedAt: stopped.receivedAt - 1 })
    ).toEqual({ status: 'unverifiable' })
    await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        session_id: session,
        prompt_id: 'second-native-prompt',
        prompt: 'second task'
      })
    )
    const working = server.getStatusSnapshotForPane(PANE)[0]
    expect(
      server.readNativeClaudeChildInventory({
        ...working,
        claudeNativeBoundaryInventory: 'complete'
      })
    ).toEqual({ status: 'unverifiable' })
    await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'StopFailure',
        session_id: session,
        prompt_id: 'second-native-prompt',
        error: 'rate_limit'
      })
    )
    expect(server.readNativeClaudeChildInventory(server.getStatusSnapshotForPane(PANE)[0])).toEqual(
      { status: 'unverifiable' }
    )
  } finally {
    server.stop()
  }
})

it('retains live non-agent and scheduled work even beside a complete lead inventory', async () => {
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  try {
    await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        session_id: session,
        prompt_id: prompt,
        prompt: 'synthetic task'
      })
    )
    await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'Stop',
        session_id: session,
        prompt_id: prompt,
        background_tasks: [{ id: 'native-shell-task', type: 'shell', status: 'running' }],
        session_crons: []
      })
    )
    expect(server.readNativeClaudeChildInventory(server.getStatusSnapshotForPane(PANE)[0])).toEqual(
      { status: 'live' }
    )
    await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'Stop',
        session_id: session,
        prompt_id: prompt,
        background_tasks: [],
        session_crons: [{ id: 'native-cron', schedule: '* * * * *', recurring: true }]
      })
    )
    expect(server.readNativeClaudeChildInventory(server.getStatusSnapshotForPane(PANE)[0])).toEqual(
      { status: 'live' }
    )
  } finally {
    server.stop()
  }
})
