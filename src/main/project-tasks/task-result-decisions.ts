import { requireTaskSourcePlacement } from './task-attempt-placement'
import { taskKnownAuthors, taskAttemptDispatchId } from './task-result-authors'
import { randomUUID } from 'node:crypto'
import { currentTaskRelations } from './task-current-relations'
import {
  TaskDelegationActor,
  taskDelegationActorsOverlap
} from '../../shared/project-task-delegation'
import type { TaskWorkflowStore } from './task-workflow-store'
import { delegationDigest, type DelegationContext } from './task-delegation-policy'
import { readTaskResult } from './task-result-evidence'
import type { ProjectTaskEntry } from '../../shared/project-task-contract'
import { taskResultAccepted, taskResultVersion } from './task-authorization'
export function decideDelegatedResult(
  store: TaskWorkflowStore,
  context: DelegationContext,
  task: ProjectTaskEntry,
  input: {
    action: 'changes' | 'integration' | 'accept'
    resultDigest: string
    reviewId: string
    requestId: string
    note: string
  },
  related: ProjectTaskEntry[]
) {
  return store.delegation.mutate(
    context.binding.projectId,
    'result.decideDelegated',
    input.requestId,
    context.actor.key,
    { context, taskId: task.id, revision: task.revision, ...input },
    () => {
      const action =
        input.action === 'changes'
          ? 'request-changes'
          : input.action === 'integration'
            ? 'send-to-integration'
            : 'accept-result'
      const grant = store.delegation.require(context, task.id, action)
      const result = readTaskResult(store, input.resultDigest)
      if (result.source) {
        requireTaskSourcePlacement(store, result.attemptId, result.source)
      }
      const attempt = store.native.db
        .prepare('SELECT project_id,task_id FROM project_task_attempts WHERE id=?')
        .get(result.attemptId)
      const latest = store.native.db
        .prepare(
          'SELECT id FROM project_task_attempts WHERE project_id=? AND task_id=? ORDER BY rowid DESC LIMIT 1'
        )
        .get(context.binding.projectId, task.id)
      const state = store.item(context.binding.projectId, task.id)
      if (
        !attempt ||
        attempt.project_id !== context.binding.projectId ||
        attempt.task_id !== task.id ||
        latest?.id !== result.attemptId ||
        result.planRevision !== task.revision ||
        state.current_revision !== task.revision ||
        state.archived ||
        !['review', 'integration'].includes(state.phase) ||
        store.active(context.binding.projectId, task.id)
      ) {
        throw new Error('Decision requires the current settled result in review')
      }
      const admission = store.native.db
        .prepare('SELECT binding_json FROM project_task_admissions WHERE attempt_id=?')
        .get(result.attemptId)
      if (
        typeof admission?.binding_json !== 'string' ||
        delegationDigest(JSON.parse(admission.binding_json)) !== delegationDigest(context.binding)
      ) {
        throw new Error('Historical plan authorization binding is unavailable or changed')
      }
      if (task.kind === 'implementation' && result.kind !== 'code') {
        throw new Error('Implementation acceptance requires a host-verified code snapshot')
      }
      const review = store.native.db
        .prepare('SELECT * FROM project_task_reviews WHERE id=? AND result_digest=?')
        .get(input.reviewId, input.resultDigest)
      if (
        !review ||
        typeof review.actor_json !== 'string' ||
        typeof review.reviewer_attempt_id !== 'string' ||
        typeof review.report !== 'string'
      ) {
        throw new Error('Independent review receipt is missing')
      }
      if (
        typeof review.review_result_digest !== 'string' ||
        readTaskResult(store, review.review_result_digest).report !== review.report ||
        review.reviewer_dispatch_id !== taskAttemptDispatchId(store, review.reviewer_attempt_id)
      ) {
        throw new Error('Settled review evidence or Dispatch changed')
      }
      const reviewState = store.native.db
        .prepare(
          'SELECT t.status FROM project_task_attempts a JOIN tasks t ON t.id=a.native_task_id WHERE a.id=?'
        )
        .get(review.reviewer_attempt_id)
      if (reviewState?.status !== 'completed') {
        throw new Error('Reviewer attempt is not authoritatively settled')
      }
      const reviewer = TaskDelegationActor.parse(JSON.parse(review.actor_json))
      const authors = taskKnownAuthors(store, result.attemptId)
      if (
        review.digest !==
          delegationDigest({
            resultDigest: input.resultDigest,
            reviewerAttemptId: review.reviewer_attempt_id,
            verdict: review.verdict,
            report: review.report,
            actor: reviewer,
            reviewResultDigest: review.review_result_digest,
            reviewerDispatchId: review.reviewer_dispatch_id
          }) ||
        authors.some((author) => taskDelegationActorsOverlap(author, reviewer)) ||
        authors.some((author) => taskDelegationActorsOverlap(author, context.actor)) ||
        review.verdict !== (input.action === 'changes' ? 'changes' : 'pass')
      ) {
        throw new Error('Independent result review or accepting actor is invalid')
      }
      if (
        input.action === 'accept' &&
        (JSON.stringify(currentTaskRelations(store, context.binding.projectId, task.id)) !==
          JSON.stringify([...new Set(related.map((entry) => entry.id))].sort()) ||
          related.some((entry) => !taskResultAccepted(store, context.binding.projectId, entry)))
      ) {
        throw new Error('Accept current dependency and child results first')
      }
      const id = randomUUID()
      store.native.db
        .prepare('UPDATE project_task_items SET phase=? WHERE project_id=? AND task_id=?')
        .run(
          input.action === 'changes'
            ? 'ready'
            : input.action === 'integration'
              ? 'integration'
              : 'done',
          context.binding.projectId,
          task.id
        )
      if (input.action === 'accept') {
        store.native.db
          .prepare(
            'INSERT INTO project_task_acceptances(project_id,task_id,revision,result_digest,review_id,receipt_id,related_json) VALUES (?,?,?,?,?,?,?)'
          )
          .run(
            context.binding.projectId,
            task.id,
            task.revision,
            input.resultDigest,
            input.reviewId,
            id,
            JSON.stringify(
              related.map((entry) => ({
                taskId: entry.id,
                revision: entry.revision,
                resultDigest:
                  store.item(context.binding.projectId, entry.id).approved_revision ===
                  entry.revision
                    ? null
                    : taskResultVersion(store, context.binding.projectId, entry.id)
              }))
            )
          )
      }
      store.event(
        context.binding.projectId,
        task,
        `review.delegated.${input.action}`,
        `Actor ${context.actor.key}; result ${input.resultDigest}; review ${input.reviewId}; ${input.note}`,
        id
      )
      return { id, operation: `review.delegated.${input.action}`, generation: grant.generation }
    }
  )
}
