import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { TaskWorkspace } from './task-workspace'
import { projectTaskTemplate } from '../../shared/project-task-template'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { TaskWorkflowStore } from './task-workflow-store'
import { claimTaskSessionInTransaction } from './task-session-attempt'
import { readTaskTextSync } from './task-file-boundary'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'task-boundary-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = new TaskWorkspace(root)
  cleanups.push(() => workspace.close())
  const project = await workspace.initialize()
  const task = await workspace.create(
    'project',
    'example',
    projectTaskTemplate({
      id: 'task-11111111-1111-4111-8111-111111111111',
      title: 'Synthetic folder'
    })
  )
  const db = new OrchestrationDb(':memory:')
  cleanups.push(async () => db.close())
  const store = new TaskWorkflowStore(db)
  store.register(project.id, root, task)
  store.approve(project.id, task)
  return { root, workspace, project, task, db, store }
}

it('rolls back Run, native task, reservation and audit when external plan bytes change before commit', async () => {
  const { root, workspace, project, task, db, store } = await setup()
  const count = (table: string) => db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n
  const before = ['runs', 'tasks', 'project_task_attempts', 'project_task_events'].map(count)
  await expect(
    workspace.withTaskRevision(task.id, task.revision, async (current, snapshot) =>
      store.transaction(() => {
        const run = db.createRun({
          objective: current.title,
          coordinatorHandle: 'synthetic',
          coordinatorPaneKey: 'pane'
        })
        claimTaskSessionInTransaction(store, project.id, current, run.id, 'owner', [])
        writeFileSync(join(root, task.path), `${task.content}\nExternal edit`)
      }, workspace.fileBoundary(snapshot))
    )
  ).rejects.toThrow(/revision conflict/)
  expect(['runs', 'tasks', 'project_task_attempts', 'project_task_events'].map(count)).toEqual(
    before
  )
})

it('rolls back at the same boundary when config bytes change without changing task bytes', async () => {
  const { root, workspace, project, task, store } = await setup()
  await expect(
    workspace.withTaskRevision(task.id, task.revision, async (current, snapshot) =>
      store.transaction(() => {
        store.moveManual(project.id, current, 'active', '')
        writeFileSync(
          join(root, '.orca/project.yaml'),
          `${readTaskTextSync(root, '.orca/project.yaml')}\n# changed`
        )
      }, workspace.fileBoundary(snapshot))
    )
  ).rejects.toThrow(/configuration changed/)
  expect(store.item(project.id, task.id).phase).toBe('ready')
})

it('uses regular bounded files in a folder workspace and refuses symlink traversal', async () => {
  const { root, task } = await setup()
  expect(readTaskTextSync(root, task.path)).toBe(task.content)
  await writeFile(join(root, 'oversized.md'), 'a'.repeat(256 * 1024 + 1))
  expect(() => readTaskTextSync(root, 'oversized.md')).toThrow(/256 KiB/)
  await symlink(join(root, task.path), join(root, 'alias.md'))
  expect(() => readTaskTextSync(root, 'alias.md')).toThrow(/symlinks/)
  expect(() => readTaskTextSync(root, '../outside.md')).toThrow(/Invalid/)
})
