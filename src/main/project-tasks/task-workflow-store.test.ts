import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { TaskWorkflowStore } from './task-workflow-store'
import { parseProjectTask } from './task-document'
import { projectTaskTemplate } from '../../shared/project-task-template'
import { projectTaskWorkflow } from './task-workflow-view'
import { assertProjectTaskNativeAdmission } from './task-native-admission'

const opened: OrchestrationDb[] = []
afterEach(() => opened.splice(0).forEach((db) => db.close()))
function setup() {
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const store = new TaskWorkflowStore(db)
  const task = {
    ...parseProjectTask(
      projectTaskTemplate({ id: 'task-11111111-1111-4111-8111-111111111111', title: 'Synthetic' })
    ),
    source: 'project',
    path: 'docs/tasks/one/task.md'
  }
  store.register('project-test', '/synthetic', task)
  return { db, store, task }
}
describe('project task workflow gates', () => {
  it('allows manual tasks without a coordinator, records operator evidence, and never rewrites managed attempts', () => {
    const { db, store, task } = setup()
    store.moveManual('project-test', task, 'active', '')
    expect(store.item('project-test', task.id).phase).toBe('active')
    expect(projectTaskWorkflow(store, 'project-test', task).attempts).toEqual([])
    expect(() => store.moveManual('project-test', task, 'done', '')).toThrow(/result and checks/)
    store.moveManual('project-test', task, 'done', 'Manually verified result, no deployment')
    expect(store.item('project-test', task.id).phase).toBe('done')
    expect(projectTaskWorkflow(store, 'project-test', task).events[0].kind).toBe('manual.done')
    store.moveManual('project-test', task, 'draft', '')
    expect(store.item('project-test', task.id).approved_revision).toBeNull()
    store.approve('project-test', task)
    const attempt = store.prepare('project-test', task, 'run_legacy_local', [])
    db.updateTaskStatus(attempt.nativeTask.id, 'completed', 'Needs review')
    expect(() => store.moveManual('project-test', task, 'done', 'Bypass')).toThrow(
      /runtime lifecycle/
    )
    expect(store.item('project-test', task.id).phase).toBe('review')
  })
  it('requires an internal project receipt for a bound native task, without changing unbound native workers', () => {
    const { db, store, task } = setup()
    const unbound = db.createTask({ runId: 'run_legacy_local', spec: 'Unbound native work' })
    expect(() => assertProjectTaskNativeAdmission(db, unbound.id, undefined)).not.toThrow()
    store.approve('project-test', task)
    const attempt = store.transaction(() =>
      store.prepare('project-test', task, 'run_legacy_local', [])
    )
    expect(() => assertProjectTaskNativeAdmission(db, attempt.nativeTask.id, undefined)).toThrow(
      /direct worker-start/
    )
    expect(() =>
      assertProjectTaskNativeAdmission(db, attempt.nativeTask.id, {
        nativeTaskId: attempt.nativeTask.id,
        attemptId: 'foreign'
      })
    ).toThrow(/admission/)
    expect(() =>
      assertProjectTaskNativeAdmission(db, attempt.nativeTask.id, {
        nativeTaskId: attempt.nativeTask.id,
        attemptId: attempt.id
      })
    ).not.toThrow()
  })
  it('requires a recorded review rejection before an implementation retry and never infers acceptance from a report', () => {
    const { db, store, task } = setup()
    store.approve('project-test', task)
    const first = store.transaction(() =>
      store.prepare('project-test', task, 'run_legacy_local', [])
    )
    db.updateTaskStatus(
      first.nativeTask.id,
      'completed',
      'Claim: CI passed for an old SHA; this is not verification'
    )
    expect(store.item('project-test', task.id).phase).toBe('review')
    expect(() => store.approve('project-test', task)).toThrow(/review decision/)
    store.decide(
      'project-test',
      task,
      'changes',
      'Independent review: result needs changes; CI SHA is stale'
    )
    const second = store.transaction(() =>
      store.prepare('project-test', task, 'run_legacy_local', [])
    )
    expect(second.id).not.toBe(first.id)
    expect(projectTaskWorkflow(store, 'project-test', task).attempts).toHaveLength(2)
    expect(store.item('project-test', task.id).phase).toBe('active')
  })
  it('blocks unknown managed authority even when its native task failed, but permits an operator retry after a confirmed stop', () => {
    const { db, store, task } = setup()
    store.approve('project-test', task)
    const attempt = store.transaction(() =>
      store.prepare('project-test', task, 'run_legacy_local', [])
    )
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: attempt.nativeTask.id,
      startOptions: {}
    })
    db.db.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(attempt.nativeTask.id)
    expect(store.active('project-test', task.id)).toBe(true)
    db.db
      .prepare("UPDATE worker_dispatches SET state='stop_unknown' WHERE dispatch_id=?")
      .run(started.dispatch.id)
    expect(store.active('project-test', task.id)).toBe(true)
    db.db
      .prepare("UPDATE worker_dispatches SET state='stopped' WHERE dispatch_id=?")
      .run(started.dispatch.id)
    db.db
      .prepare("UPDATE dispatch_contexts SET status='failed' WHERE id=?")
      .run(started.dispatch.id)
    db.db.prepare("UPDATE tasks SET status='blocked' WHERE id=?").run(attempt.nativeTask.id)
    expect(store.active('project-test', task.id)).toBe(false)
    store.approve('project-test', task)
    expect(store.item('project-test', task.id).phase).toBe('ready')
  })
  it('retains immutable attempt text and rejects a missing native task as unverified', () => {
    const { db, store, task } = setup()
    store.approve('project-test', task)
    const attempt = store.transaction(() =>
      store.prepare('project-test', task, 'run_legacy_local', [])
    )
    expect(db.getTask(attempt.nativeTask.id)?.spec).toContain(task.content)
    db.db.prepare('DELETE FROM tasks WHERE id=?').run(attempt.nativeTask.id)
    expect(store.active('project-test', task.id)).toBe(true)
    expect(projectTaskWorkflow(store, 'project-test', task).attempts[0].nativeStatus).toBe(
      'unknown'
    )
    expect(() => store.approve('project-test', task)).toThrow(/active/)
  })
  it('rolls back reservations atomically and keeps board summaries bounded', () => {
    const { db, store, task } = setup()
    store.approve('project-test', task)
    expect(() =>
      store.transaction(() => {
        store.prepare('project-test', task, 'run_legacy_local', [])
        throw new Error('rollback')
      })
    ).toThrow('rollback')
    expect(store.active('project-test', task.id)).toBe(false)
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM project_task_attempts').get()?.n).toBe(0)
    expect(projectTaskWorkflow(store, 'project-test', task, true).events).toEqual([])
  })
  it('binds one attempt, records runtime completion, but never auto-accepts work', () => {
    const { db, store, task } = setup()
    expect(() => store.prepare('project-test', task, 'run_legacy_local', [])).toThrow(/Approve/)
    store.approve('project-test', task)
    const attempt = store.transaction(() =>
      store.prepare('project-test', task, 'run_legacy_local', [])
    )
    expect(() => store.prepare('project-test', task, 'run_legacy_local', [])).toThrow(/active/)
    db.updateTaskStatus(attempt.nativeTask.id, 'completed', 'Synthetic worker result')
    expect(store.item('project-test', task.id).phase).toBe('review')
    expect(() => store.decide('project-test', task, 'accept', '')).toThrow(/evidence/)
    store.decide(
      'project-test',
      task,
      'accept',
      'Operator reviewed synthetic result; no deployment'
    )
    expect(store.item('project-test', task.id).phase).toBe('done')
  })
  it('rejects changed revisions, active archive, unmet dependencies and copied project IDs', () => {
    const { store, task } = setup()
    store.approve('project-test', task)
    expect(() =>
      store.prepare('project-test', { ...task, revision: 'changed' }, 'run_legacy_local', [])
    ).toThrow(/Approve/)
    expect(() => store.prepare('project-test', task, 'run_legacy_local', [task])).toThrow(
      /dependency/
    )
    store.prepare('project-test', task, 'run_legacy_local', [])
    expect(() => store.archive('project-test', task, true)).toThrow(/active/)
    expect(() => store.register('project-test', '/another-root', task)).toThrow(/another root/)
  })
})
