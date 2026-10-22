import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
import { buildBody, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

it('routes five project coordinators and their native children through one HTTP hook store', async () => {
  const server = new AgentHookServer()
  const sidebar = vi.fn(),
    dashboard = vi.fn()
  server.subscribeStatusChanges(sidebar)
  server.subscribeStatusChanges(dashboard)
  await server.start({ env: 'production' })
  const projects = Array.from({ length: 5 }, (_, index) => ({
    paneKey: makePaneKey(`tab-${index}`, randomUUID()),
    tabId: `tab-${index}`,
    worktreeId: `worktree-${index}`,
    child: `reviewer-${index}`
  }))
  const post = async (index: number, payload: Record<string, unknown>) => {
    const entry = projects[index]
    const response = await postHookEvent(server, buildBody(payload, entry), '/hook/codex')
    expect(response.status).toBe(204)
  }
  try {
    await Promise.all(
      projects.map(async (entry, index) => {
        await post(index, {
          hook_event_name: 'UserPromptSubmit',
          session_id: `session-${index}`,
          prompt: `PROJECT_SCOPE_${index}`,
          model: 'fixture-parent'
        })
        await post(index, {
          hook_event_name: 'SubagentStart',
          session_id: entry.child,
          agent_id: entry.child,
          agent_type: 'reviewer',
          model: 'fixture-child'
        })
      })
    )
    const snapshot = server.getStatusSnapshot()
    expect(snapshot).toHaveLength(5)
    for (const [index, entry] of projects.entries()) {
      expect(snapshot.find((row) => row.paneKey === entry.paneKey)).toMatchObject({
        worktreeId: entry.worktreeId,
        prompt: `PROJECT_SCOPE_${index}`,
        subagents: [
          { id: entry.child, agentType: 'reviewer', model: 'fixture-child', state: 'working' }
        ]
      })
    }
    await post(0, {
      hook_event_name: 'PermissionRequest',
      agent_id: projects[0].child,
      tool_name: 'exec_command',
      tool_input: { cmd: 'synthetic protected operation' }
    })
    expect(server.getStatusSnapshot().filter((row) => row.state === 'waiting')).toHaveLength(1)
    expect(sidebar.mock.lastCall?.[0]).toEqual(dashboard.mock.lastCall?.[0])
    for (const [index, entry] of projects.entries()) {
      await post(index, { hook_event_name: 'SubagentStop', agent_id: entry.child })
      await post(index, { hook_event_name: 'Stop', session_id: `session-${index}` })
    }
    expect(server.getStatusSnapshot().every((row) => row.state === 'done')).toBe(true)
  } finally {
    server.stop()
  }
})
