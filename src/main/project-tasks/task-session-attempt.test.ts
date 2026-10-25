import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { TaskWorkflowStore } from './task-workflow-store'
import { parseProjectTask } from './task-document'
import { projectTaskTemplate } from '../../shared/project-task-template'
import {
  claimTaskSession,
  readTaskSessionAttempt,
  recordTaskSessionProgress
} from './task-session-attempt'

const opened: OrchestrationDb[] = []
afterEach(() => opened.splice(0).forEach((db) => db.close()))
function setup() {
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const store = new TaskWorkflowStore(db)
  const task = {
    ...parseProjectTask(
      projectTaskTemplate({
        id: 'task-11111111-1111-4111-8111-111111111111',
        title: 'Synthetic'
      })
    ),
    path: 'docs/work/tasks/one/task.md',
    source: 'project'
  }
  store.register('project-one', '/synthetic', task)
  const claim = (owner = 'chat-one') =>
    claimTaskSession(store, 'project-one', task, 'run_legacy_local', owner, [])
  const progress = (
    id: string,
    input: Parameters<typeof recordTaskSessionProgress>[5],
    owner = 'chat-one'
  ) => recordTaskSessionProgress(store, 'project-one', task, id, owner, input)
  return { db, store, task, claim, progress }
}

describe('a task worked by an existing chat', () => {
  it('requires approval and reuses the same active attempt without a Dispatch', () => {
    const { db, store, task, claim } = setup()
    expect(() => claim()).toThrow(/Approve/)
    store.approve('project-one', task)
    const first = claim()
    expect(claim().id).toBe(first.id)
    expect(store.active('project-one', task.id)).toBe(true)
    expect(db.db.prepare('SELECT COUNT(1) AS n FROM dispatch_contexts').get()?.n).toBe(0)
    expect(() => claim('chat-two')).toThrow(/another chat/)
  })

  it('persists a blocker and requires a report before entering review, never Done', () => {
    const { store, task, claim, progress } = setup()
    store.approve('project-one', task)
    const attempt = claim()
    progress(attempt.id, { checkpointPath: 'checkpoint.md', blocker: 'API contract missing' })
    expect(readTaskSessionAttempt(store, 'project-one', task.id)?.blocker).toBe(
      'API contract missing'
    )
    expect(store.item('project-one', task.id).phase).toBe('active')
    const result = {
      checkpointPath: 'checkpoint.md',
      blocker: null,
      reportPath: 'reports/result.md',
      resultHash: 'sha256-result'
    }
    progress(attempt.id, result)
    expect(store.item('project-one', task.id).phase).toBe('review')
    const sequence = store.native.db
      .prepare('SELECT COUNT(1) AS n FROM project_task_events')
      .get()?.n
    progress(attempt.id, result)
    expect(store.native.db.prepare('SELECT COUNT(1) AS n FROM project_task_events').get()?.n).toBe(
      sequence
    )
    expect(() => progress(attempt.id, { ...result, resultHash: 'different' })).toThrow(
      /already submitted/
    )
    expect(store.item('project-one', task.id).phase).not.toBe('done')
  })

  it('rejects another owner and changed plan revisions before a progress write', () => {
    const { store, task, claim, progress } = setup()
    store.approve('project-one', task)
    const attempt = claim()
    expect(() =>
      progress(attempt.id, { checkpointPath: 'checkpoint.md', blocker: null }, 'chat-two')
    ).toThrow(/another chat/)
    const changed = { ...task, revision: 'f'.repeat(64) }
    store.register('project-one', '/synthetic', changed)
    expect(() =>
      recordTaskSessionProgress(store, 'project-one', changed, attempt.id, 'chat-one', {
        checkpointPath: 'checkpoint.md',
        blocker: null
      })
    ).toThrow(/plan changed/)
  })

  it('restores ownership and checkpoint receipts from disk without inferring process liveness', async () => {
    const { db, store, task, claim, progress } = setup()
    store.approve('project-one', task)
    const first = claim()
    progress(first.id, { checkpointPath: 'checkpoint.md', blocker: 'Needs operator input' })
    const root = await mkdtemp(join(tmpdir(), 'opka-session-backup-'))
    let restored: OrchestrationDb | undefined
    try {
      const path = join(root, 'runtime.db')
      await db.db.backup(path)
      restored = new OrchestrationDb(path)
      const recoveredStore = new TaskWorkflowStore(restored)
      expect(readTaskSessionAttempt(recoveredStore, 'project-one', task.id)).toMatchObject({
        id: first.id,
        checkpointPath: 'checkpoint.md',
        blocker: 'Needs operator input'
      })
      expect(
        claimTaskSession(recoveredStore, 'project-one', task, 'run_legacy_local', 'chat-one', []).id
      ).toBe(first.id)
      expect(() =>
        claimTaskSession(recoveredStore, 'project-one', task, 'run_legacy_local', 'chat-two', [])
      ).toThrow(/another chat/)
    } finally {
      restored?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lets only the old owner relinquish an attempt after a plan change, without approving the new plan', () => {
    const { store, task, claim } = setup()
    store.approve('project-one', task)
    const first = claim()
    const changed = { ...task, revision: 'f'.repeat(64) }
    store.register('project-one', '/synthetic', changed)
    const release = (owner: string) =>
      recordTaskSessionProgress(store, 'project-one', changed, first.id, owner, {
        checkpointPath: 'checkpoint.md',
        blocker: null,
        release: true
      })
    expect(() => release('chat-two')).toThrow(/another chat/)
    release('chat-one')
    expect(store.active('project-one', task.id)).toBe(false)
    expect(store.item('project-one', task.id).phase).toBe('draft')
    expect(() =>
      claimTaskSession(store, 'project-one', changed, 'run_legacy_local', 'chat-two', [])
    ).toThrow(/Approve/)
  })
})
