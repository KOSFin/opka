import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { TaskWorkspace } from './task-workspace'
import { TaskWorkflowStore } from './task-workflow-store'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { projectTaskTemplate } from '../../shared/project-task-template'
import { projectTaskWorkflow } from './task-workflow-view'
import { exportProjectTaskActivity } from './task-activity'

it('isolates five simultaneous project plans, retries, journals and restored checkpoints', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'orca-five-projects-')))
  const dbPath = join(directory, 'runtime.db')
  let db = new OrchestrationDb(dbPath)
  const workspaces: TaskWorkspace[] = []
  try {
    let store = new TaskWorkflowStore(db)
    const projects = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const root = join(directory, `project-${index}`)
        await mkdir(root)
        const workspace = new TaskWorkspace(root)
        workspaces.push(workspace)
        const project = await workspace.initialize()
        const task = await workspace.create(
          'project',
          'implementation',
          projectTaskTemplate({
            id: 'task-11111111-1111-4111-8111-111111111111',
            title: `Project ${index} implementation`,
            goal: `Only implement PROJECT_SCOPE_${index}`,
            detailed: true
          })
        )
        await writeFile(
          join(root, dirname(task.path), 'checkpoint.md'),
          `Next action for PROJECT_SCOPE_${index}: review only this project's implementation.`
        )
        store.register(project.id, root, task)
        store.approve(project.id, task)
        const run = db.createRun({
          objective: `Project ${index}`,
          coordinatorHandle: `coordinator-${index}`,
          coordinatorPaneKey: `tab-${index}:leaf-${index}`
        })
        const attempt = store.prepare(project.id, task, run.id, [])
        return { root, workspace, project, task, attempt, run, index }
      })
    )
    expect(new Set(projects.map((entry) => entry.attempt.nativeTask.id)).size).toBe(5)
    for (const entry of projects) {
      const context = await entry.workspace.context(entry.task.id)
      expect(context.text).toContain(`PROJECT_SCOPE_${entry.index}`)
      expect(context.checkpoint?.freshness).toBe('unverified')
      for (const other of projects.filter((candidate) => candidate !== entry)) {
        expect(context.text).not.toContain(`PROJECT_SCOPE_${other.index}`)
      }
      expect(db.getTask(entry.attempt.nativeTask.id)?.spec).toContain(entry.root)
      expect(await readFile(join(entry.root, '.orca/task-workflow.md'), 'utf8')).toContain(
        'Before stopping or switching accounts'
      )
    }
    for (const entry of projects) {
      db.updateTaskStatus(entry.attempt.nativeTask.id, 'completed', `Result ${entry.index}`)
      expect(projectTaskWorkflow(store, entry.project.id, entry.task).phase).toBe('review')
    }
    const rejected = projects[0]
    store.decide(rejected.project.id, rejected.task, 'changes', 'Independent review requests a fix')
    const retry = store.prepare(rejected.project.id, rejected.task, rejected.run.id, [])
    db.updateTaskStatus(retry.nativeTask.id, 'completed', 'Corrected result')
    for (const entry of projects) {
      store.decide(
        entry.project.id,
        entry.task,
        'accept',
        `Reviewed only PROJECT_SCOPE_${entry.index}`
      )
    }
    await exportProjectTaskActivity(db.db)
    await Promise.all(workspaces.map((workspace) => workspace.close()))
    db.close()
    db = new OrchestrationDb(dbPath)
    store = new TaskWorkflowStore(db)
    for (const entry of projects) {
      const restored = new TaskWorkspace(entry.root)
      workspaces.push(restored)
      const context = await restored.context(entry.task.id)
      expect(context.checkpoint?.content).toContain(`PROJECT_SCOPE_${entry.index}`)
      expect(context.execution).toBe('unknown')
      const workflow = projectTaskWorkflow(store, entry.project.id, entry.task)
      expect(workflow.phase).toBe('done')
      expect(workflow.attempts).toHaveLength(entry.index === 0 ? 2 : 1)
      const journal = await readFile(
        join(entry.root, dirname(entry.task.path), 'activity.md'),
        'utf8'
      )
      expect(journal).toContain(`Reviewed only PROJECT_SCOPE_${entry.index}`)
      expect(journal).not.toContain(`Reviewed only PROJECT_SCOPE_${(entry.index + 1) % 5}`)
    }
  } finally {
    await Promise.all(workspaces.map((workspace) => workspace.close()))
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
})
