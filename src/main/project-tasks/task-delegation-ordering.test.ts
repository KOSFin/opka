import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { taskResultFixture } from './task-result-test-fixture'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { TaskWorkflowStore } from './task-workflow-store'
import { reserveProjectTaskLaunch } from './task-launch-reservation'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'delegation-order-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'synthetic.db')
  const h = taskResultFixture(path)
  cleanups.push(async () => h.db.close())
  const peer = new OrchestrationDb(path)
  cleanups.push(async () => peer.close())
  const second = new TaskWorkflowStore(peer)
  const task = {
    ...h.task,
    id: 'task-33333333-3333-4333-8333-333333333333',
    path: 'docs/tasks/future/task.md'
  }
  h.store.register('project', '/synthetic', task)
  h.store.transaction(() => h.store.delegation.approve(h.director, task, randomUUID()))
  const revoke = () =>
    second.transaction(() => {
      const p = second.delegation.propose(
        'project',
        'interactive-device',
        'connection',
        2,
        null,
        h.binding
      )
      return second.delegation.confirm(
        'project',
        'interactive-device',
        'connection',
        p.id,
        p.digest,
        randomUUID(),
        h.binding
      )
    })
  const reserve = (id = randomUUID()) =>
    h.store.transaction(() =>
      reserveProjectTaskLaunch(h.store, 'project', task, 'run_legacy_local', [], h.director, id, {
        placement: 'synthetic'
      })
    )
  return { ...h, second, task, revoke, reserve }
}
it('orders revoke before reservation on a second connection without new native Task/attempt', async () => {
  const h = await setup()
  const count = () => h.db.db.prepare('SELECT COUNT(*) AS n FROM project_task_attempts').get()?.n
  const before = count()
  h.revoke()
  expect(() => h.reserve()).toThrow(/Approve/)
  expect(count()).toBe(before)
})
it('orders reservation before revoke and replays the same one-use launch without duplicate worker resources', async () => {
  const h = await setup()
  const id = randomUUID()
  const first = h.reserve(id)
  h.revoke()
  const replay = h.reserve(id)
  expect(replay.id).toBe(first.id)
  expect(replay.nativeTask.id).toBe(first.nativeTask.id)
  expect(replay.replayed).toBe(true)
  expect(
    h.db.db
      .prepare('SELECT COUNT(*) AS n FROM project_task_attempts WHERE task_id=?')
      .get(h.task.id)?.n
  ).toBe(1)
  expect(h.store.item('project', h.task.id).approved_revision).toBeNull()
})
it('rolls back a new Run, native Task, reservation and phase when reservation audit fails', async () => {
  const h = await setup()
  h.db.db.exec(
    "CREATE TRIGGER fail_launch_audit BEFORE INSERT ON project_task_delegation_audit WHEN NEW.operation='attempt.launch' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END"
  )
  const before = h.db.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n
  expect(() =>
    h.store.transaction(() => {
      const run = h.db.createRun({
        objective: 'Synthetic',
        coordinatorHandle: 'synthetic',
        coordinatorPaneKey: 'pane'
      })
      reserveProjectTaskLaunch(h.store, 'project', h.task, run.id, [], h.director, randomUUID(), {
        placement: 'synthetic'
      })
    })
  ).toThrow(/audit unavailable/)
  expect(h.db.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(before)
  expect(
    h.db.db
      .prepare('SELECT COUNT(*) AS n FROM project_task_attempts WHERE task_id=?')
      .get(h.task.id)?.n
  ).toBe(0)
  expect(h.store.item('project', h.task.id).phase).toBe('ready')
})
