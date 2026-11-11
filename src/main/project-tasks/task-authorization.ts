import { z } from 'zod'
import { currentTaskRelations } from './task-current-relations'
import type { ProjectTaskEntry } from '../../shared/project-task-contract'
import { TaskDelegationActor, TaskDelegationBinding } from '../../shared/project-task-delegation'
import type { TaskWorkflowStore } from './task-workflow-store'
import { delegationDigest, type DelegationContext } from './task-delegation-policy'

const Reservation = z.object({ binding_json: z.string(), owner_json: z.string() })

export function taskAdmission(
  store: TaskWorkflowStore,
  projectId: string,
  task: ProjectTaskEntry,
  context?: DelegationContext
) {
  const state = store.item(projectId, task.id)
  if (state.archived || state.current_revision !== task.revision) {
    return null
  }
  if (state.approved_revision === task.revision) {
    return { source: 'manual' as const, id: null, generation: null }
  }
  if (!context || context.binding.projectId !== projectId) {
    return null
  }
  try {
    return { source: 'delegated' as const, ...store.delegation.admission(context, task) }
  } catch {
    return null
  }
}

export function taskResultAccepted(
  store: TaskWorkflowStore,
  projectId: string,
  task: ProjectTaskEntry
): boolean {
  return acceptedResult(store, projectId, task.id, task.revision, new Set(), new Map())
}

const AcceptedRelations = z
  .array(
    z.object({ taskId: z.string(), revision: z.string(), resultDigest: z.string().nullable() })
  )
  .max(1000)
export function taskResultVersion(
  store: TaskWorkflowStore,
  projectId: string,
  taskId: string
): string | null {
  const row = store.native.db
    .prepare(`SELECT r.digest FROM project_task_attempts a JOIN project_task_results r ON r.attempt_id=a.id
    WHERE a.id=(SELECT id FROM project_task_attempts WHERE project_id=? AND task_id=? ORDER BY rowid DESC LIMIT 1)
    ORDER BY r.rowid DESC LIMIT 1`)
    .get(projectId, taskId)
  return typeof row?.digest === 'string' ? row.digest : null
}
function acceptedResult(
  store: TaskWorkflowStore,
  projectId: string,
  taskId: string,
  revision: string,
  visiting: Set<string>,
  verified: Map<string, boolean>
): boolean {
  const key = JSON.stringify([taskId, revision])
  const cached = verified.get(key)
  if (cached !== undefined) {
    return cached
  }
  if (visiting.has(taskId) || visiting.size >= 1000) {
    return false
  }
  visiting.add(taskId)
  try {
    const state = store.item(projectId, taskId)
    if (
      state.archived ||
      state.phase !== 'done' ||
      state.current_revision !== revision ||
      !store.native.db
        .prepare('SELECT 1 FROM project_task_graph WHERE project_id=? AND task_id=?')
        .get(projectId, taskId)
    ) {
      return false
    }
    if (state.approved_revision === revision) {
      return true
    }
    const digest = taskResultVersion(store, projectId, taskId)
    if (!digest) {
      return false
    }
    const receipt = store.native.db
      .prepare(
        'SELECT related_json FROM project_task_acceptances WHERE project_id=? AND task_id=? AND revision=? AND result_digest=? ORDER BY rowid DESC LIMIT 1'
      )
      .get(projectId, taskId, revision, digest)
    if (typeof receipt?.related_json !== 'string') {
      return false
    }
    const relations = AcceptedRelations.parse(JSON.parse(receipt.related_json))
    const currentRelations = currentTaskRelations(store, projectId, taskId)
    const capturedIds = relations.map((entry) => entry.taskId).sort()
    if (JSON.stringify(currentRelations) !== JSON.stringify(capturedIds)) {
      return false
    }
    const accepted = relations.every((entry) => {
      const current = store.item(projectId, entry.taskId)
      const version =
        current.approved_revision === entry.revision
          ? null
          : taskResultVersion(store, projectId, entry.taskId)
      return (
        version === entry.resultDigest &&
        acceptedResult(store, projectId, entry.taskId, entry.revision, visiting, verified)
      )
    })
    verified.set(key, accepted)
    return accepted
  } catch {
    return false
  } finally {
    visiting.delete(taskId)
  }
}

export function captureTaskAdmission(
  store: TaskWorkflowStore,
  projectId: string,
  task: ProjectTaskEntry,
  attemptId: string,
  context?: DelegationContext
): void {
  const admission = taskAdmission(store, projectId, task, context)
  if (!admission) {
    throw new Error('Approve the current plan revision before starting')
  }
  if (context) {
    store.native.db
      .prepare(
        'INSERT INTO project_task_admissions(attempt_id,source,receipt_id,binding_json,owner_json,generation) VALUES (?,?,?,?,?,?)'
      )
      .run(
        attemptId,
        admission.source,
        admission.id,
        JSON.stringify(context.binding),
        JSON.stringify(context.actor),
        admission.generation
      )
  }
}

export function requireReservedTaskScope(
  store: TaskWorkflowStore,
  attemptId: string,
  context?: DelegationContext
): boolean {
  const row = store.native.db
    .prepare('SELECT binding_json,owner_json FROM project_task_admissions WHERE attempt_id=?')
    .get(attemptId)
  if (!row) {
    return false
  }
  const admission = Reservation.parse(row)
  const binding = TaskDelegationBinding.parse(JSON.parse(admission.binding_json))
  const actor = TaskDelegationActor.parse(JSON.parse(admission.owner_json))
  if (
    !context ||
    delegationDigest(binding) !== delegationDigest(context.binding) ||
    actor.key !== context.actor.key
  ) {
    throw new Error('Reserved attempt host/project/config/owner binding changed')
  }
  return true
}
