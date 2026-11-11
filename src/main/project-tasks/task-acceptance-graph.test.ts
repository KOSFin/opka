import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { taskResultFixture } from './task-result-test-fixture'
import { assignTaskReview, recordTaskReview } from './task-independent-review'
import { decideDelegatedResult } from './task-result-decisions'
import { taskResultAccepted } from './task-authorization'
import { freezeTaskResult, readTaskResult } from './task-result-evidence'
import { currentTaskRelations } from './task-current-relations'

const fixtures: ReturnType<typeof taskResultFixture>[] = []
afterEach(() => fixtures.splice(0).forEach((h) => h.db.close()))
function accepted(withChild = false) {
  const h = taskResultFixture()
  fixtures.push(h)
  h.completeImplementation()
  const resultDigest = h.resultDigest()
  h.store.transaction(() =>
    assignTaskReview(h.store, h.director, h.task.id, resultDigest, h.review.id)
  )
  h.completeReview()
  const review = h.store.transaction(() =>
    recordTaskReview(
      h.store,
      h.reviewer,
      resultDigest,
      h.review.id,
      'pass',
      'Exact independent review'
    )
  )
  const child = { ...h.reviewTask, parent: withChild ? h.task.id : null }
  h.store.register('project', '/synthetic', child)
  h.store.decide('project', child, 'accept', 'Genuine manual review fixture')
  const decision = {
    action: 'accept' as const,
    resultDigest,
    reviewId: review.id,
    requestId: randomUUID(),
    note: ''
  }
  h.store.transaction(() =>
    decideDelegatedResult(h.store, h.director, h.task, decision, withChild ? [child] : [])
  )
  expect(taskResultAccepted(h.store, 'project', h.task)).toBe(true)
  return { ...h, child, decision }
}
it.each(['removed', 'reparented', 'revised'] as const)(
  'invalidates historical parent when its child is %s',
  (change) => {
    const h = accepted(true)
    if (change === 'removed') {
      h.store.syncGraph('project', '/synthetic', [h.task])
    } else {
      h.store.register('project', '/synthetic', {
        ...h.child,
        ...(change === 'reparented' ? { parent: null } : { revision: 'f'.repeat(64) })
      })
    }
    expect(taskResultAccepted(h.store, 'project', h.task)).toBe(false)
  }
)
it('blocks downstream readiness when a new child is attached without changing the parent', () => {
  const h = accepted()
  const downstream = { ...h.child, id: 'downstream', depends_on: [h.task.id] }
  h.store.register('project', '/synthetic', downstream)
  h.store.approve('project', downstream)
  h.store.requireReady('project', downstream, [h.task])
  h.store.register('project', '/synthetic', { ...h.child, id: 'new-child', parent: h.task.id })
  expect(() => h.store.requireReady('project', downstream, [h.task])).toThrow(/dependency/)
})
it('syncs deleted membership atomically and preserves manual historical compatibility', () => {
  const h = accepted(true)
  expect(() =>
    h.store.transaction(() => {
      h.store.syncGraph('project', '/synthetic', [h.task])
      throw new Error('boundary conflict')
    })
  ).toThrow(/boundary conflict/)
  expect(taskResultAccepted(h.store, 'project', h.task)).toBe(true)
  h.store.register('project', '/synthetic', { ...h.child, id: 'manual-child', parent: h.child.id })
  expect(taskResultAccepted(h.store, 'project', h.child)).toBe(true)
})
it('checks a bounded large graph once per related result and refuses cycles', () => {
  const h = accepted()
  const nodes = Array.from({ length: 998 }, (_, index) => ({
    ...h.child,
    id: `child-${index}`,
    parent: h.task.id
  }))
  h.store.syncGraph('project', '/synthetic', [h.task, h.child, ...nodes])
  expect(currentTaskRelations(h.store, 'project', h.task.id)).toHaveLength(998)
  expect(taskResultAccepted(h.store, 'project', h.task)).toBe(false)
  expect(() =>
    h.store.syncGraph('project', '/synthetic', [h.task, h.child, ...nodes, h.task])
  ).toThrow(/capacity/)
  // Synthetic cyclic history must fail closed even if corrupted outside the graph validator.
  h.store.syncGraph('project', '/synthetic', [{ ...h.task, depends_on: [h.task.id] }])
  h.db.db
    .prepare(`INSERT INTO project_task_acceptances(project_id,task_id,revision,result_digest,review_id,receipt_id,related_json)
    VALUES (?,?,?,?,?,?,?)`)
    .run(
      'project',
      h.task.id,
      h.task.revision,
      h.decision.resultDigest,
      h.decision.reviewId,
      randomUUID(),
      JSON.stringify([
        { taskId: h.task.id, revision: h.task.revision, resultDigest: h.decision.resultDigest }
      ])
    )
  expect(taskResultAccepted(h.store, 'project', h.task)).toBe(false)
})

it('invalidates a parent when a delegated child result changes without a plan revision change', () => {
  const h = accepted(true)
  const childDigest = h.db.db
    .prepare(
      'SELECT digest FROM project_task_results WHERE attempt_id=? ORDER BY rowid DESC LIMIT 1'
    )
    .get(h.review.id)?.digest
  if (typeof childDigest !== 'string') {
    throw new Error('Child result fixture missing')
  }
  // Isolate the historical projection using the existing settled child and review evidence.
  h.db.db
    .prepare(
      'UPDATE project_task_items SET approved_revision=NULL WHERE project_id=? AND task_id=?'
    )
    .run('project', h.child.id)
  const insert = h.db.db.prepare(
    `INSERT INTO project_task_acceptances(project_id,task_id,revision,result_digest,review_id,receipt_id,related_json) VALUES (?,?,?,?,?,?,?)`
  )
  insert.run(
    'project',
    h.child.id,
    h.child.revision,
    childDigest,
    h.decision.reviewId,
    randomUUID(),
    '[]'
  )
  insert.run(
    'project',
    h.task.id,
    h.task.revision,
    h.decision.resultDigest,
    h.decision.reviewId,
    randomUUID(),
    JSON.stringify([{ taskId: h.child.id, revision: h.child.revision, resultDigest: childDigest }])
  )
  expect(taskResultAccepted(h.store, 'project', h.task)).toBe(true)
  const child = readTaskResult(h.store, childDigest)
  h.store.transaction(() =>
    freezeTaskResult(h.store, { ...child, report: 'Corrected child result' })
  )
  expect(taskResultAccepted(h.store, 'project', h.task)).toBe(false)
})

it('reconciles changed dependency membership and refuses missing current dependency documents', () => {
  const h = accepted(true)
  h.store.register('project', '/synthetic', { ...h.child, parent: null })
  h.store.register('project', '/synthetic', { ...h.task, depends_on: [h.child.id] })
  expect(taskResultAccepted(h.store, 'project', h.task)).toBe(true)
  h.store.syncGraph('project', '/synthetic', [{ ...h.task, depends_on: [h.child.id] }])
  expect(taskResultAccepted(h.store, 'project', h.task)).toBe(false)
  h.store.syncGraph('project', '/synthetic', [h.task, { ...h.child, parent: null }])
  expect(taskResultAccepted(h.store, 'project', h.task)).toBe(false)
})
