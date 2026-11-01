import { describe, expect, it, vi } from 'vitest'
import {
  taskSchema,
  documentsRead,
  catalogRead,
  loadProjectTaskBoard,
  PROJECT_TASK_PRESENTATION_READ_OPTIONS
} from './project-task-rpc'

import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { rpcSuccess, rpcRefusal } from '../transport/rpc-operation-test-families'

const task = {
  id: 'task-1',
  title: 'Ship',
  revision: 'a'.repeat(64),
  path: 'docs/task.md',
  workflow: {
    phase: 'review',
    archived: false,
    revisionChanged: false,
    attempts: [
      {
        id: 'attempt-1',
        nativeStatus: 'completed',
        terminal: null,
        session: { blocker: null, reportPath: 'reports/result.md' }
      }
    ],
    events: [
      { sequence: 1, kind: 'result', detail: 'Tests passed', createdAt: '2026-10-30T00:00:00Z' }
    ]
  }
}

describe('mobile project task contracts', () => {
  it('preserves review evidence and accepts additive host fields', () => {
    const parsed = taskSchema.parse({ ...task, futureField: true })
    expect(parsed.workflow.phase).toBe('review')
    expect(parsed.workflow.attempts[0].session?.reportPath).toBe('reports/result.md')
    expect(parsed.workflow.events[0].detail).toBe('Tests passed')
  })
  it('refuses malformed workflow rather than displaying successful work', () => {
    expect(taskSchema.safeParse({ ...task, workflow: undefined }).success).toBe(false)
  })
  it('loads all pages without mixing host ownership', async () => {
    const client = new FakeSession('connected')
    const page = {
      project: { id: 'project-1' },
      executionHostId: 'runtime:one',
      total: 101,
      tasks: [task]
    }
    client.sendRequest
      .mockResolvedValueOnce(rpcSuccess(page))
      .mockResolvedValueOnce(rpcSuccess({ ...page, tasks: [{ ...task, id: 'task-2' }] }))
    expect(
      (await loadProjectTaskBoard(client, 'folder:/project')).tasks.map((row) => row.id)
    ).toEqual(['task-1', 'task-2'])
    expect(client.sendRequest).toHaveBeenLastCalledWith('projectTask.board', {
      worktree: 'folder:/project',
      offset: 100,
      limit: 100
    })
  })
  it('rejects a changed execution owner during pagination', async () => {
    const client = new FakeSession('connected')
    const page = {
      project: { id: 'project-1' },
      executionHostId: 'runtime:one',
      total: 101,
      tasks: [task]
    }
    client.sendRequest
      .mockResolvedValueOnce(rpcSuccess(page))
      .mockResolvedValueOnce(rpcSuccess({ ...page, executionHostId: 'runtime:two' }))
    await expect(loadProjectTaskBoard(client, 'folder:/project')).rejects.toThrow('Project changed')
  })
  it('does not turn an old-host refusal into an empty board', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockResolvedValue(rpcRefusal('method_not_found', 'Update host'))
    await expect(catalogRead.request(client).then(catalogRead.interpret)).rejects.toThrow(
      'Update host'
    )
  })
  it('only reads a report through the task-scoped document method', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockResolvedValue(
      rpcSuccess({ paths: ['reports/a.md'], path: 'reports/a.md', content: 'Checked' })
    )
    const result = documentsRead.interpret(
      await documentsRead.request(client, {
        worktree: 'folder:/project',
        id: 'task-1',
        path: 'reports/a.md'
      })
    )
    expect(result.content).toBe('Checked')
    expect(client.sendRequest).toHaveBeenCalledWith('projectTask.documents', {
      worktree: 'folder:/project',
      id: 'task-1',
      path: 'reports/a.md'
    })
  })
  it('never dispatches a later page to a replacement generation', async () => {
    let generation = 0
    const client = Object.assign(new FakeSession('connected'), { getGeneration: () => generation })
    let finish!: (value: ReturnType<typeof rpcSuccess>) => void
    client.sendRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const pending = loadProjectTaskBoard(
      client,
      'folder:/private',
      PROJECT_TASK_PRESENTATION_READ_OPTIONS
    )
    generation += 1
    finish(rpcSuccess({ project: { id: 'p' }, executionHostId: 'old', total: 101, tasks: [task] }))
    await expect(pending).rejects.toThrow('owner changed')
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })
  it('rejects a disconnected page instead of retaining a request for reconnect', async () => {
    const client = new FakeSession('connected')
    client.sendRequest.mockImplementationOnce(async () => {
      client.publishState('disconnected')
      return rpcSuccess({ project: { id: 'p' }, executionHostId: 'one', total: 101, tasks: [task] })
    })
    await expect(
      loadProjectTaskBoard(client, 'folder:/p', PROJECT_TASK_PRESENTATION_READ_OPTIONS)
    ).rejects.toThrow('disconnected')
    client.publishState('connected')
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })
  it('shares one finite presentation deadline across pages', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const client = new FakeSession('connected')
      const page = { project: { id: 'p' }, executionHostId: 'one', total: 101, tasks: [task] }
      client.sendRequest
        .mockImplementationOnce(async () => {
          clock.mockReturnValue(6_000)
          return rpcSuccess(page)
        })
        .mockResolvedValueOnce(rpcSuccess({ ...page, tasks: [] }))
      await loadProjectTaskBoard(client, 'folder:/p', PROJECT_TASK_PRESENTATION_READ_OPTIONS)
      expect(client.sendRequest).toHaveBeenNthCalledWith(
        1,
        'projectTask.board',
        { worktree: 'folder:/p', offset: 0, limit: 100 },
        PROJECT_TASK_PRESENTATION_READ_OPTIONS
      )
      expect(client.sendRequest).toHaveBeenNthCalledWith(
        2,
        'projectTask.board',
        { worktree: 'folder:/p', offset: 100, limit: 100 },
        { ...PROJECT_TASK_PRESENTATION_READ_OPTIONS, timeoutMs: 25_000 }
      )
    } finally {
      clock.mockRestore()
    }
  })
})
