import { taskDispatchActor } from './task-result-authors'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { TaskWorkflowStore } from './task-workflow-store'
import { freezeTaskResult } from './task-result-evidence'

export function freezeNativeProjectTaskResult(
  native: OrchestrationDb,
  taskId: string,
  dispatchId: string,
  report: string
): void {
  const attempt = native.db
    .prepare('SELECT id,revision FROM project_task_attempts WHERE native_task_id=?')
    .get(taskId)
  if (!attempt || typeof attempt.id !== 'string' || typeof attempt.revision !== 'string') {
    return
  }
  const dispatch = native.getDispatchContextById(dispatchId)
  if (
    !dispatch ||
    (!dispatch.assignee_orca_session_id && !dispatch.process_incarnation) ||
    !report.trim() ||
    report.length > 10000
  ) {
    return
  }
  const actor = taskDispatchActor(native, dispatchId)
  if (!actor) {
    return
  }
  freezeTaskResult(new TaskWorkflowStore(native), {
    attemptId: attempt.id,
    nativeTaskId: taskId,
    dispatchId,
    planRevision: attempt.revision,
    author: actor,
    kind: 'other',
    report,
    source: null
  })
}
