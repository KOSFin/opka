import { requireTaskSourcePlacement } from './task-attempt-placement'
import { taskAttemptAuthor, taskKnownAuthors, taskAttemptDispatchId } from './task-result-authors'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { taskDelegationActorsOverlap } from '../../shared/project-task-delegation'
import type { TaskWorkflowStore } from './task-workflow-store'
import { delegationDigest, type DelegationContext } from './task-delegation-policy'
import { readTaskResult } from './task-result-evidence'
export function assignTaskReview(
  store: TaskWorkflowStore,
  context: DelegationContext,
  taskId: string,
  resultDigest: string,
  reviewerAttemptId: string
) {
  store.delegation.require(context, taskId, 'accept-result')
  const evidence = readTaskResult(store, resultDigest)
  if (evidence.source) {
    requireTaskSourcePlacement(store, evidence.attemptId, evidence.source)
  }
  const resultTask = store.native.db
    .prepare('SELECT project_id,task_id FROM project_task_attempts WHERE id=?')
    .get(evidence.attemptId)
  if (resultTask?.project_id !== context.binding.projectId || resultTask.task_id !== taskId) {
    throw new Error('Review result belongs to another project/task')
  }
  const target = store.native.db
    .prepare(
      `SELECT a.project_id,t.status FROM project_task_attempts a JOIN tasks t ON t.id=a.native_task_id WHERE a.id=?`
    )
    .get(reviewerAttemptId)
  if (
    !target ||
    target.project_id !== context.binding.projectId ||
    !['ready', 'dispatched'].includes(String(target.status))
  ) {
    throw new Error('Assign a verified active review attempt before it settles')
  }
  const actor = taskAttemptAuthor(store, reviewerAttemptId)
  if (
    taskKnownAuthors(store, evidence.attemptId).some((author) =>
      taskDelegationActorsOverlap(actor, author)
    )
  ) {
    throw new Error('Reviewer cannot be an author')
  }
  const id = randomUUID()
  store.native.db
    .prepare(
      'INSERT INTO project_task_review_assignments(id,result_digest,reviewer_attempt_id,actor_json,assigned_by,reviewer_dispatch_id) VALUES (?,?,?,?,?,?)'
    )
    .run(
      id,
      resultDigest,
      reviewerAttemptId,
      JSON.stringify(actor),
      context.actor.key,
      taskAttemptDispatchId(store, reviewerAttemptId)
    )
  return { id }
}

export function recordTaskReview(
  store: TaskWorkflowStore,
  context: DelegationContext,
  resultDigest: string,
  reviewerAttemptId: string,
  verdict: 'pass' | 'changes',
  report: string
) {
  const evidence = readTaskResult(store, resultDigest)
  if (evidence.source) {
    requireTaskSourcePlacement(store, evidence.attemptId, evidence.source)
  }
  const resultTask = store.native.db
    .prepare('SELECT project_id FROM project_task_attempts WHERE id=?')
    .get(evidence.attemptId)
  if (resultTask?.project_id !== context.binding.projectId) {
    throw new Error('Review result belongs to another project')
  }
  const review = store.native.db
    .prepare(
      'SELECT a.project_id,t.status FROM project_task_attempts a JOIN tasks t ON t.id=a.native_task_id WHERE a.id=?'
    )
    .get(reviewerAttemptId)
  if (!review || review.project_id !== context.binding.projectId || review.status !== 'completed') {
    throw new Error('Review requires an independently owned settled review attempt')
  }
  const actor = taskAttemptAuthor(store, reviewerAttemptId)
  if (
    actor.key !== context.actor.key ||
    taskKnownAuthors(store, evidence.attemptId).some((author) =>
      taskDelegationActorsOverlap(actor, author)
    )
  ) {
    throw new Error('Reviewer identity is unverified or overlaps an author')
  }
  const assignment = store.native.db
    .prepare(
      'SELECT actor_json,reviewer_dispatch_id FROM project_task_review_assignments WHERE result_digest=? AND reviewer_attempt_id=?'
    )
    .get(resultDigest, reviewerAttemptId)
  const frozen = store.native.db
    .prepare(
      'SELECT digest FROM project_task_results WHERE attempt_id=? ORDER BY rowid DESC LIMIT 1'
    )
    .get(reviewerAttemptId)
  if (
    !assignment ||
    assignment.reviewer_dispatch_id !== taskAttemptDispatchId(store, reviewerAttemptId) ||
    assignment.actor_json !== JSON.stringify(actor) ||
    typeof frozen?.digest !== 'string' ||
    readTaskResult(store, frozen.digest).report !== report
  ) {
    throw new Error('Review must match its prior host assignment and exact settled report')
  }
  const bounded = z
    .string()
    .max(10000)
    .refine((text) => text.trim().length > 0, 'Report must not be blank')
    .parse(report)
  const id = randomUUID()
  const digest = delegationDigest({
    resultDigest,
    reviewerAttemptId,
    verdict,
    report: bounded,
    actor,
    reviewResultDigest: frozen.digest,
    reviewerDispatchId: assignment.reviewer_dispatch_id
  })
  store.native.db
    .prepare(
      'INSERT INTO project_task_reviews(id,result_digest,reviewer_attempt_id,verdict,report,digest,actor_json,review_result_digest,reviewer_dispatch_id) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      resultDigest,
      reviewerAttemptId,
      verdict,
      bounded,
      digest,
      JSON.stringify(actor),
      frozen.digest,
      assignment.reviewer_dispatch_id
    )
  return { id, digest }
}
