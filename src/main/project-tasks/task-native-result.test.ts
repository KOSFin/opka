import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { TaskWorkflowStore } from './task-workflow-store'
import { parseProjectTask } from './task-document'
import { projectTaskTemplate } from '../../shared/project-task-template'
import { requireTaskSourcePlacement } from './task-attempt-placement'
import { delegationDigest } from './task-delegation-policy'
import { freezeTaskResult, readTaskResult } from './task-result-evidence'
import { taskDispatchActor } from './task-result-authors'

const opened: OrchestrationDb[] = []
afterEach(() => opened.splice(0).forEach((db) => db.close()))
function fixture() {
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const store = new TaskWorkflowStore(db)
  const task = {
    ...parseProjectTask(
      projectTaskTemplate({
        id: 'task-11111111-1111-4111-8111-111111111111',
        title: 'Synthetic native report'
      })
    ),
    source: 'project',
    path: 'docs/tasks/one/task.md'
  }
  store.register('project', '/synthetic', task)
  store.approve('project', task)
  const attempt = store.transaction(() => store.prepare('project', task, 'run_legacy_local', []))
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: attempt.nativeTask.id,
    startOptions: {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: 'term_synthetic',
    paneKey: 'tab_synthetic:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    processIncarnation: 'synthetic-worker:1',
    worktreeId: 'repo::worker',
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  const report = {
    taskId: attempt.nativeTask.id,
    dispatchId: started.dispatch.id,
    outcome: 'succeeded' as const,
    result: 'Exact native result'
  }
  const results = () =>
    db.db.prepare('SELECT digest FROM project_task_results WHERE attempt_id=?').all(attempt.id)
  return { db, store, task, attempt, report, results }
}
it('freezes the exact settled Dispatch report once without inferring acceptance', () => {
  const h = fixture()
  expect(h.db.settleWorkerReport(h.report)).toMatchObject({ action: 'settled', duplicate: false })
  expect(h.results()).toHaveLength(1)
  const digest = h.results()[0].digest
  if (typeof digest !== 'string') {
    throw new Error('Missing native evidence')
  }
  expect(readTaskResult(h.store, digest)).toMatchObject({
    dispatchId: h.report.dispatchId,
    attemptId: h.attempt.id,
    report: h.report.result,
    source: null,
    kind: 'other',
    author: taskDispatchActor(h.db, h.report.dispatchId)
  })
  expect(h.db.settleWorkerReport(h.report)).toMatchObject({ action: 'settled', duplicate: true })
  expect(h.results()).toHaveLength(1)
  expect(h.store.item('project', h.task.id).phase).toBe('review')
})
it('rejects foreign reports and leaves failed or oversized legacy reports outside delegated evidence', () => {
  const h = fixture()
  expect(h.db.settleWorkerReport({ ...h.report, taskId: 'foreign' })).toMatchObject({
    action: 'rejected'
  })
  expect(h.results()).toHaveLength(0)
  expect(h.db.settleWorkerReport({ ...h.report, outcome: 'failed' })).toMatchObject({
    action: 'settled'
  })
  expect(h.results()).toHaveLength(0)
  const large = fixture()
  expect(large.db.settleWorkerReport({ ...large.report, result: 'x'.repeat(10001) })).toMatchObject(
    { action: 'settled' }
  )
  expect(large.results()).toHaveLength(0)
})
it('rolls back lifecycle settlement if immutable evidence cannot be committed', () => {
  const h = fixture()
  h.db.db.exec(
    "CREATE TRIGGER reject_synthetic_evidence BEFORE INSERT ON project_task_results BEGIN SELECT RAISE(ABORT,'synthetic evidence failure'); END"
  )
  expect(() => h.db.settleWorkerReport(h.report)).toThrow(/synthetic evidence failure/)
  expect(h.results()).toHaveLength(0)
  expect(h.db.getTask(h.report.taskId)?.status).toBe('dispatched')
  expect(h.db.getDispatchContextById(h.report.dispatchId)?.status).toBe('dispatched')
})

it('joins code evidence to the settled native Dispatch placement and author', () => {
  const h = fixture()
  const owner = taskDispatchActor(h.db, h.report.dispatchId)
  if (!owner) {
    throw new Error('Native author fixture missing')
  }
  const placement = {
    workspaceId: 'repo::worker',
    executionHostId: 'local',
    worktreePath: '/synthetic/worker',
    owner
  }
  const source = {
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    dirtyDigest: null,
    worktreePath: placement.worktreePath,
    workspaceId: placement.workspaceId,
    placementDigest: delegationDigest({ attemptId: h.attempt.id, ...placement })
  }
  expect(() => requireTaskSourcePlacement(h.store, h.attempt.id, source)).toThrow(/placement/)
  h.db.settleWorkerReport(h.report)
  requireTaskSourcePlacement(h.store, h.attempt.id, source)
  const digest = h.results()[0].digest
  if (typeof digest !== 'string') {
    throw new Error('Native result fixture missing')
  }
  const result = readTaskResult(h.store, digest)
  const frozen = h.store.transaction(() =>
    freezeTaskResult(h.store, { ...result, kind: 'code', source })
  )
  expect(readTaskResult(h.store, frozen.digest).source).toEqual(source)
  expect(() =>
    requireTaskSourcePlacement(h.store, h.attempt.id, { ...source, workspaceId: 'repo::baseline' })
  ).toThrow(/provenance/)
  expect(() =>
    h.store.transaction(() =>
      freezeTaskResult(h.store, { ...result, kind: 'code', source, dispatchId: null })
    )
  ).toThrow(/exact settled/)
})
