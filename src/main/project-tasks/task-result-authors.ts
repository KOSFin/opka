import { createHash } from 'node:crypto'
import { TaskDelegationActor, type DelegationActor } from '../../shared/project-task-delegation'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import type { TaskWorkflowStore } from './task-workflow-store'

export function taskDispatchActor(
  native: OrchestrationDb,
  dispatchId: string
): DelegationActor | null {
  const dispatch = native.getDispatchContextById(dispatchId)
  if (!dispatch || native.getFederatedDispatch(dispatchId)) {
    return null
  }
  const aliases = [
    dispatch.assignee_orca_session_id
      ? createHash('sha256')
          .update(JSON.stringify(['session', dispatch.assignee_orca_session_id]))
          .digest('hex')
      : null,
    dispatch.process_incarnation
      ? createHash('sha256')
          .update(JSON.stringify(['process', dispatch.process_incarnation]))
          .digest('hex')
      : null
  ].filter((alias): alias is string => alias !== null)
  return aliases[0] ? { key: aliases[0], aliases } : null
}

export function taskAttemptAuthor(store: TaskWorkflowStore, attemptId: string): DelegationActor {
  const session = store.native.db
    .prepare(
      'SELECT b.owner_json FROM project_task_session_attempts s JOIN project_task_admissions b ON b.attempt_id=s.attempt_id WHERE s.attempt_id=?'
    )
    .get(attemptId)
  if (typeof session?.owner_json === 'string') {
    return TaskDelegationActor.parse(JSON.parse(session.owner_json))
  }
  const dispatch = store.native.db
    .prepare(
      'SELECT d.id FROM dispatch_contexts d JOIN project_task_attempts a ON a.native_task_id=d.task_id WHERE a.id=? ORDER BY d.rowid DESC LIMIT 1'
    )
    .get(attemptId)
  const actor =
    typeof dispatch?.id === 'string' ? taskDispatchActor(store.native, dispatch.id) : null
  if (!actor) {
    throw new Error('Attempt author identity cannot be established')
  }
  return actor
}

export function taskKnownAuthors(store: TaskWorkflowStore, attemptId: string): DelegationActor[] {
  const attempts = store.native.db
    .prepare(
      `SELECT a.id FROM project_task_attempts a JOIN project_task_attempts target ON target.project_id=a.project_id AND target.task_id=a.task_id WHERE target.id=?`
    )
    .all(attemptId)
  return attempts.map((row) => {
    if (typeof row.id !== 'string') {
      throw new Error('Unknown author binding')
    }
    return taskAttemptAuthor(store, row.id)
  })
}

export function taskAttemptDispatchId(store: TaskWorkflowStore, attemptId: string): string | null {
  const session = store.native.db
    .prepare('SELECT 1 FROM project_task_session_attempts WHERE attempt_id=?')
    .get(attemptId)
  if (session) {
    return null
  }
  const dispatch = store.native.db
    .prepare(
      'SELECT d.id FROM dispatch_contexts d JOIN project_task_attempts a ON a.native_task_id=d.task_id WHERE a.id=? ORDER BY d.rowid DESC LIMIT 1'
    )
    .get(attemptId)
  if (typeof dispatch?.id !== 'string') {
    throw new Error('Review Dispatch binding is unknown')
  }
  return dispatch.id
}
