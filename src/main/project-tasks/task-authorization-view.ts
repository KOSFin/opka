import { TaskDelegationActor, TaskDelegationBinding } from '../../shared/project-task-delegation'
import type { ProjectTaskEntry } from '../../shared/project-task-contract'
import type { TaskWorkflowStore } from './task-workflow-store'
import { taskAdmission, taskResultAccepted } from './task-authorization'
import { delegationDigest, type DelegationContext } from './task-delegation-policy'

export function taskAuthorizationView(
  store: TaskWorkflowStore,
  projectId: string,
  task: ProjectTaskEntry,
  context: DelegationContext
) {
  const admission = taskAdmission(store, projectId, task, context)
  let eligible = false
  try {
    store.requireReady(
      projectId,
      task,
      task.depends_on.map((id) => ({
        ...task,
        id,
        revision: store.item(projectId, id).current_revision
      })),
      context
    )
    eligible = true
  } catch {
    eligible = false
  }
  const reserved = store.native.db
    .prepare(
      `SELECT a.revision,b.source,b.binding_json,b.owner_json,t.status FROM project_task_attempts a JOIN project_task_admissions b ON b.attempt_id=a.id JOIN tasks t ON t.id=a.native_task_id WHERE a.project_id=? AND a.task_id=? ORDER BY a.rowid DESC LIMIT 1`
    )
    .get(projectId, task.id)
  const results = store.native.db
    .prepare(
      `SELECT r.digest,r.id FROM project_task_results r JOIN project_task_attempts a ON a.id=r.attempt_id WHERE a.project_id=? AND a.task_id=? ORDER BY r.rowid DESC LIMIT 1`
    )
    .get(projectId, task.id)
  const ownerMatches =
    typeof reserved?.owner_json === 'string' &&
    TaskDelegationActor.parse(JSON.parse(reserved.owner_json)).key === context.actor.key
  return {
    schema: 1 as const,
    admission: {
      eligible,
      source: admission?.source ?? 'none',
      revision: task.revision,
      receiptId: admission?.id ?? null,
      generation: admission?.generation ?? null,
      reason: admission
        ? null
        : 'Manual approval or a current actor-scoped delegated receipt is required'
    },
    continuation: {
      eligible:
        !!reserved &&
        ownerMatches &&
        typeof reserved.binding_json === 'string' &&
        delegationDigest(TaskDelegationBinding.parse(JSON.parse(reserved.binding_json))) ===
          delegationDigest(context.binding) &&
        reserved.revision === task.revision &&
        !['completed', 'failed', 'unknown'].includes(String(reserved.status)),
      authorizedRevision: typeof reserved?.revision === 'string' ? reserved.revision : null,
      ownerBinding: ownerMatches ? delegationDigest(context.actor) : null
    },
    acceptance: {
      accepted: taskResultAccepted(store, projectId, task),
      revision: task.revision,
      resultDigest: typeof results?.digest === 'string' ? results.digest : null
    }
  }
}
