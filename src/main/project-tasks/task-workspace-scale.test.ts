import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { TaskWorkspace } from './task-workspace'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { TaskWorkflowStore } from './task-workflow-store'
import { exportProjectTaskActivity } from './task-activity'
import { projectTaskTemplate } from '../../shared/project-task-template'
import { projectTaskWorkflow } from './task-workflow-view'

it('bounds a 1000-task / 10000-event workspace and does not parse again while idle', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-task-scale-')))
  let watchCount = 0,
    releaseCount = 0
  const workspace = new TaskWorkspace(root, async () => {
    watchCount++
    return async () => {
      releaseCount++
    }
  })
  const db = new OrchestrationDb(join(root, 'runtime.db'))
  const store = new TaskWorkflowStore(db)
  try {
    await workspace.initialize()
    for (let start = 0; start < 1000; start += 32) {
      await Promise.all(
        Array.from({ length: Math.min(32, 1000 - start) }, async (_, offset) => {
          const directory = join(root, 'docs/work/tasks', String(start + offset))
          await mkdir(directory, { recursive: true })
          await writeFile(
            join(directory, 'task.md'),
            projectTaskTemplate({
              id: `task-${randomUUID()}`,
              title: `Synthetic task ${start + offset}`
            })
          )
        })
      )
    }
    const rss = process.memoryUsage().rss,
      cpu = process.cpuUsage(),
      began = performance.now()
    const first = await workspace.snapshot(),
      scanMs = performance.now() - began
    expect(first.tasks).toHaveLength(1000)
    expect(first.diagnostics).toEqual([])
    const parses = workspace.parseCount
    const idleStart = performance.now()
    for (let index = 0; index < 20; index++) {
      await workspace.snapshot()
    }
    const idleReadsMs = performance.now() - idleStart
    expect(workspace.parseCount).toBe(parses)
    expect(watchCount).toBe(1)
    store.transaction(() => {
      for (const task of first.tasks) {
        store.register(first.project.id, root, task)
      }
      for (let index = 0; index < 10000; index++) {
        store.event(
          first.project.id,
          first.tasks[0],
          'scale.event',
          String(index),
          `scale-${index}`
        )
      }
    })
    const detail = projectTaskWorkflow(store, first.project.id, first.tasks[0])
    expect(detail.events).toHaveLength(200)
    expect(projectTaskWorkflow(store, first.project.id, first.tasks[0], true).events).toEqual([])
    for (let batch = 0; batch < 60; batch++) {
      await exportProjectTaskActivity(db.db)
      if (
        !db.db
          .prepare(
            `SELECT i.task_id FROM project_task_items i WHERE i.export_error IS NULL AND COALESCE((SELECT MAX(sequence) FROM project_task_events e WHERE e.project_id=i.project_id AND e.task_id=i.task_id),0)>i.exported_sequence LIMIT 1`
          )
          .get()
      ) {
        break
      }
      if (batch === 59) {
        throw new Error('Activity export did not converge within its batch budget')
      }
    }
    const totalMs = performance.now() - began,
      usage = process.cpuUsage(cpu)
    console.log(
      'PROJECT_TASK_SCALE',
      JSON.stringify({
        tasks: 1000,
        events: Number(db.db.prepare('SELECT COUNT(*) AS n FROM project_task_events').get()?.n),
        scanMs,
        idleReadsMs,
        totalMs,
        rssDeltaBytes: process.memoryUsage().rss - rss,
        cpuUserMs: usage.user / 1000,
        cpuSystemMs: usage.system / 1000,
        parses: workspace.parseCount,
        watchCount
      })
    )
    expect(totalMs).toBeLessThan(15000)
    await workspace.close()
    expect(releaseCount).toBe(1)
  } finally {
    await workspace.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
