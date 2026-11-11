import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { taskResultFixture } from './task-result-test-fixture'
import { assignTaskReview, recordTaskReview } from './task-independent-review'
import { decideDelegatedResult } from './task-result-decisions'
import { freezeTaskResult, readTaskResult } from './task-result-evidence'
import { taskResultAccepted } from './task-authorization'

const fixtures: ReturnType<typeof taskResultFixture>[] = []
const setup = () => {
  const h = taskResultFixture()
  fixtures.push(h)
  return h
}
afterEach(() => fixtures.splice(0).forEach((h) => h.db.close()))
function reviewed() {
  const h = setup()
  h.completeImplementation()
  const digest = h.resultDigest()
  h.store.transaction(() => assignTaskReview(h.store, h.director, h.task.id, digest, h.review.id))
  h.completeReview()
  const review = h.store.transaction(() =>
    recordTaskReview(h.store, h.reviewer, digest, h.review.id, 'pass', 'Exact independent review')
  )
  const decide = (action: 'changes' | 'integration' | 'accept' = 'accept', context = h.director) =>
    h.store.transaction(() =>
      decideDelegatedResult(
        h.store,
        context,
        h.task,
        { action, resultDigest: digest, reviewId: review.id, requestId: randomUUID(), note: '' },
        []
      )
    )
  return { ...h, digest, receipt: review, decide }
}
it('requires settled retained reports and independent review, then preserves historical acceptance after revoke', () => {
  const h = reviewed()
  expect(h.store.item('project', h.task.id).phase).toBe('review')
  h.decide()
  expect(taskResultAccepted(h.store, 'project', h.task)).toBe(true)
  const p = h.store.transaction(() =>
    h.store.delegation.propose('project', 'interactive-device', 'connection', 2, null, h.binding)
  )
  h.store.transaction(() =>
    h.store.delegation.confirm(
      'project',
      'interactive-device',
      'connection',
      p.id,
      p.digest,
      randomUUID(),
      h.binding
    )
  )
  expect(taskResultAccepted(h.store, 'project', h.task)).toBe(true)
  const changed = { ...h.task, revision: 'f'.repeat(64) }
  h.store.register('project', '/synthetic', changed)
  expect(taskResultAccepted(h.store, 'project', changed)).toBe(false)
  expect(h.store.item('project', h.task.id).approved_revision).toBeNull()
})
it('rejects fabricated report, missing assignment, uncompleted review and forged reviewer identity', () => {
  const h = setup()
  h.completeImplementation()
  const digest = h.resultDigest()
  expect(() =>
    h.store.transaction(() =>
      recordTaskReview(h.store, h.reviewer, digest, h.review.id, 'pass', 'Exact independent review')
    )
  ).toThrow(/settled/)
  h.completeReview()
  expect(() =>
    h.store.transaction(() =>
      recordTaskReview(h.store, h.reviewer, digest, h.review.id, 'pass', 'Exact independent review')
    )
  ).toThrow(/assignment/)
  expect(() =>
    h.store.transaction(() =>
      recordTaskReview(
        h.store,
        h.implementer,
        digest,
        h.review.id,
        'pass',
        'Exact independent review'
      )
    )
  ).toThrow(/identity/)
  expect(() =>
    h.store.transaction(() => assignTaskReview(h.store, h.director, h.task.id, digest, h.review.id))
  ).toThrow(/before it settles/)
})
it('rejects missing/stale result and immutable evidence mutation, and a correction invalidates earlier review', () => {
  const h = reviewed()
  expect(() => readTaskResult(h.store, '0'.repeat(64))).toThrow(/missing/)
  expect(() =>
    h.db.db
      .prepare('UPDATE project_task_results SET evidence_json=? WHERE digest=?')
      .run('{}', h.digest)
  ).toThrow(/immutable/)
  const prior = readTaskResult(h.store, h.digest)
  h.store.transaction(() =>
    freezeTaskResult(h.store, { ...prior, report: 'Corrected immutable report' })
  )
  expect(() => h.decide()).toThrow(/revision changed/)
})
it('rejects mutable review evidence and requires current child/dependency acceptance', () => {
  const h = reviewed()
  expect(() =>
    h.db.db
      .prepare('UPDATE project_task_reviews SET report=? WHERE id=?')
      .run('Altered', h.receipt.id)
  ).toThrow(/immutable/)
  expect(() =>
    h.store.transaction(() =>
      decideDelegatedResult(
        h.store,
        h.director,
        h.task,
        {
          action: 'accept',
          resultDigest: h.digest,
          reviewId: h.receipt.id,
          requestId: randomUUID(),
          note: ''
        },
        [h.reviewTask]
      )
    )
  ).toThrow(/dependency and child/)
})
it('refuses report-only implementation acceptance, grant revocation, and action-limited decisions', () => {
  const h = reviewed()
  expect(() =>
    h.store.transaction(() =>
      decideDelegatedResult(
        h.store,
        h.director,
        { ...h.task, kind: 'implementation' },
        {
          action: 'accept',
          resultDigest: h.digest,
          reviewId: h.receipt.id,
          requestId: randomUUID(),
          note: ''
        },
        []
      )
    )
  ).toThrow(/code snapshot/)
  const p = h.store.transaction(() =>
    h.store.delegation.propose('project', 'interactive-device', 'connection', 2, null, h.binding)
  )
  h.store.transaction(() =>
    h.store.delegation.confirm(
      'project',
      'interactive-device',
      'connection',
      p.id,
      p.digest,
      randomUUID(),
      h.binding
    )
  )
  expect(() => h.decide()).toThrow(/revoked/)
})

it('invalidates accepted history when the retained result is corrected at the same plan revision', () => {
  const h = reviewed()
  h.decide()
  expect(taskResultAccepted(h.store, 'project', h.task)).toBe(true)
  const result = readTaskResult(h.store, h.digest)
  h.store.transaction(() => freezeTaskResult(h.store, { ...result, report: 'A corrected result' }))
  expect(taskResultAccepted(h.store, 'project', h.task)).toBe(false)
})
it('invalidates parent acceptance when a previously accepted child changes revision', () => {
  const h = reviewed()
  h.store.register('project', '/synthetic', { ...h.reviewTask, parent: h.task.id })
  h.store.decide('project', h.reviewTask, 'accept', 'Synthetic genuine manual reviewer decision')
  h.store.transaction(() =>
    decideDelegatedResult(
      h.store,
      h.director,
      h.task,
      {
        action: 'accept',
        resultDigest: h.digest,
        reviewId: h.receipt.id,
        requestId: randomUUID(),
        note: ''
      },
      [h.reviewTask]
    )
  )
  expect(taskResultAccepted(h.store, 'project', h.task)).toBe(true)
  h.store.register('project', '/synthetic', { ...h.reviewTask, revision: 'e'.repeat(64) })
  expect(taskResultAccepted(h.store, 'project', h.task)).toBe(false)
})

it('retains exact report whitespace so raw content hashes remain verifiable', () => {
  const h = reviewed()
  const original = readTaskResult(h.store, h.digest)
  const report = '  Exact retained bytes\n\n'
  const frozen = h.store.transaction(() => freezeTaskResult(h.store, { ...original, report }))
  expect(readTaskResult(h.store, frozen.digest).report).toBe(report)
})
