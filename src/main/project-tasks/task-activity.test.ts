import { mkdtemp, readFile, realpath, rm, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { TaskWorkflowStore } from './task-workflow-store'
import { parseProjectTask } from './task-document'
import { projectTaskTemplate } from '../../shared/project-task-template'
import { exportProjectTaskActivity, closeProjectTaskActivity } from './task-activity'

const directories: string[] = []
const opened: OrchestrationDb[] = []
afterEach(async () => {
  const closing = opened.splice(0)
  closing.forEach((db) => closeProjectTaskActivity(db.db))
  await Promise.all(closing.map((db) => exportProjectTaskActivity(db.db)))
  closing.forEach((db) => db.close())
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-task-activity-')))
  directories.push(root)
  const db = new OrchestrationDb(join(root, 'runtime.db'))
  opened.push(db)
  const store = new TaskWorkflowStore(db)
  const task = {
    ...parseProjectTask(
      projectTaskTemplate({ id: 'task-11111111-1111-4111-8111-111111111111', title: 'Synthetic' })
    ),
    source: 'project',
    path: 'tasks/one/task.md'
  }
  store.register('project-fixture', root, task)
  return { root, db, store, task }
}
describe('committed project task activity', () => {
  it('backs up committed runtime receipts and approval without claiming a restored process is live', async () => {
    const { root, db, store, task } = await fixture()
    store.approve('project-fixture', task)
    await db.db.backup(join(root, 'runtime-copy.db'))
    store.event('project-fixture', task, 'after.backup', 'not in snapshot')
    const restored = new OrchestrationDb(join(root, 'runtime-copy.db'))
    opened.push(restored)
    const restoredStore = new TaskWorkflowStore(restored)
    expect(restoredStore.item('project-fixture', task.id).approved_revision).toBe(task.revision)
    expect(
      restored.db
        .prepare("SELECT COUNT(*) AS n FROM project_task_events WHERE kind='after.backup'")
        .get()?.n
    ).toBe(0)
  })
  it('re-exports a renamed task path without leaving its cursor pointing at a missing file', async () => {
    const { root, db, store, task } = await fixture()
    store.approve('project-fixture', task)
    await exportProjectTaskActivity(db.db)
    store.register('project-fixture', root, { ...task, path: 'tasks/moved/task.md' })
    await exportProjectTaskActivity(db.db)
    expect(await readFile(join(root, 'tasks/moved/activity.md'), 'utf8')).toContain(
      'document.changed'
    )
    expect(store.item('project-fixture', task.id).approved_revision).toBe(task.revision)
  })
  it('exports once, serializes concurrent exports, and rebuilds after a lost file cursor', async () => {
    const { root, db, store, task } = await fixture()
    store.transaction(() => store.approve('project-fixture', task))
    await Promise.all([exportProjectTaskActivity(db.db), exportProjectTaskActivity(db.db)])
    const file = join(root, 'tasks/one/activity.md')
    const text = await readFile(file, 'utf8')
    expect(text.match(/plan.approved/g)).toHaveLength(1)
    store.event('project-fixture', task, 'checkpoint.recorded', 'Synthetic next step')
    db.db.prepare('UPDATE project_task_items SET exported_sequence=0').run()
    await exportProjectTaskActivity(db.db)
    const next = await readFile(file, 'utf8')
    expect(next.match(/plan.approved/g)).toHaveLength(1)
    expect(next).toContain('checkpoint.recorded')
  })
  it('does not export uncommitted or rolled-back events', async () => {
    const { db, store, task } = await fixture()
    db.db.exec('BEGIN IMMEDIATE')
    store.event('project-fixture', task, 'not.committed', 'not authoritative')
    await expect(exportProjectTaskActivity(db.db)).rejects.toThrow(/committed/)
    db.db.exec('ROLLBACK')
    expect(
      db.db
        .prepare("SELECT COUNT(*) AS n FROM project_task_events WHERE kind='not.committed'")
        .get()?.n
    ).toBe(0)
  })
  it('refuses symlink export targets and holds failed exports for explicit retry', async () => {
    const { root, db, store, task } = await fixture()
    await mkdir(join(root, 'outside'))
    await symlink(join(root, 'outside'), join(root, 'tasks'))
    store.event('project-fixture', task, 'example', 'synthetic')
    await exportProjectTaskActivity(db.db)
    expect(store.item('project-fixture', task.id).export_error).toMatch(/failed/)
    await expect(readFile(join(root, 'outside/one/activity.md'), 'utf8')).rejects.toThrow()
  })
  it('recovers pending activity after reopening the same runtime database', async () => {
    const { root, db, store, task } = await fixture()
    closeProjectTaskActivity(db.db)
    store.event('project-fixture', task, 'before.restart', 'durable fact')
    opened.splice(opened.indexOf(db), 1)
    db.close()
    const restored = new OrchestrationDb(join(root, 'runtime.db'))
    opened.push(restored)
    await exportProjectTaskActivity(restored.db)
    expect(await readFile(join(root, 'tasks/one/activity.md'), 'utf8')).toContain('before.restart')
  })
})
