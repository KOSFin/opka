import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { projectTaskTemplate } from '../../shared/project-task-template'
import { TaskWorkspace } from './task-workspace'
import { TaskWorkflowStore } from './task-workflow-store'
import {
  claimTaskSession,
  readTaskSessionAttempt,
  recordTaskSessionProgress
} from './task-session-attempt'
import { exportProjectTaskActivity } from './task-activity'

it('restores five chat owners in a thirty-project portfolio and keeps review isolated', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'opka-portfolio-')))
  const databasePath = join(directory, 'runtime.db')
  let database = new OrchestrationDb(databasePath)
  const workspaces: TaskWorkspace[] = []
  try {
    let store = new TaskWorkflowStore(database)
    const projects = await Promise.all(
      Array.from({ length: 30 }, async (_, index) => {
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
            title: `Project ${index}`,
            goal: `Only change PORTFOLIO_SCOPE_${index}.`,
            detailed: true
          })
        )
        store.register(project.id, root, task)
        store.approve(project.id, task)
        return { root, project, task, owner: `chat-${index}` }
      })
    )
    const active = projects.slice(0, 5).map((entry) => ({
      ...entry,
      attempt: claimTaskSession(
        store,
        entry.project.id,
        entry.task,
        'run_legacy_local',
        entry.owner,
        []
      )
    }))
    expect(new Set(active.map((entry) => entry.attempt.nativeTaskId)).size).toBe(5)
    for (const entry of active) {
      recordTaskSessionProgress(
        store,
        entry.project.id,
        entry.task,
        entry.attempt.id,
        entry.owner,
        {
          checkpointPath: join(dirname(entry.task.path), 'checkpoint.md'),
          blocker: `Awaiting contract for ${entry.owner}`
        }
      )
    }
    database.close()
    database = new OrchestrationDb(databasePath)
    store = new TaskWorkflowStore(database)
    for (const entry of active) {
      const claim = () =>
        claimTaskSession(store, entry.project.id, entry.task, 'run_legacy_local', entry.owner, [])
      expect(claim().id).toBe(entry.attempt.id)
      expect(readTaskSessionAttempt(store, entry.project.id, entry.task.id)?.blocker).toBe(
        `Awaiting contract for ${entry.owner}`
      )
      expect(() =>
        claimTaskSession(
          store,
          entry.project.id,
          entry.task,
          'run_legacy_local',
          'competing-chat',
          []
        )
      ).toThrow(/another chat/)
      recordTaskSessionProgress(
        store,
        entry.project.id,
        entry.task,
        entry.attempt.id,
        entry.owner,
        {
          checkpointPath: null,
          blocker: null,
          reportPath: join(dirname(entry.task.path), 'reports', `${entry.attempt.id}.md`),
          resultHash: `result-${entry.owner}`
        }
      )
      expect(store.item(entry.project.id, entry.task.id).phase).toBe('review')
    }
    const rejected = active[0]
    store.decide(rejected.project.id, rejected.task, 'changes', 'Fix the integration contract')
    const retry = claimTaskSession(
      store,
      rejected.project.id,
      rejected.task,
      'run_legacy_local',
      rejected.owner,
      []
    )
    expect(retry.id).not.toBe(rejected.attempt.id)
    recordTaskSessionProgress(store, rejected.project.id, rejected.task, retry.id, rejected.owner, {
      checkpointPath: null,
      blocker: null,
      reportPath: 'reports/revised.md',
      resultHash: 'revised-result'
    })
    for (const entry of active) {
      store.decide(entry.project.id, entry.task, 'accept', `Accepted ${entry.owner}`)
      expect(store.item(entry.project.id, entry.task.id).phase).toBe('done')
    }
    for (const entry of projects.slice(5)) {
      expect(store.item(entry.project.id, entry.task.id).phase).toBe('ready')
      expect(readTaskSessionAttempt(store, entry.project.id, entry.task.id)).toBeNull()
    }
    await exportProjectTaskActivity(database.db)
    await exportProjectTaskActivity(database.db)
    for (const entry of active) {
      const journal = await readFile(
        join(entry.root, dirname(entry.task.path), 'activity.md'),
        'utf8'
      )
      expect(journal).toContain(`Accepted ${entry.owner}`)
      for (const other of active.filter((candidate) => candidate !== entry)) {
        expect(journal).not.toContain(`Accepted ${other.owner}`)
      }
    }
  } finally {
    await Promise.all(workspaces.map((workspace) => workspace.close()))
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
})
