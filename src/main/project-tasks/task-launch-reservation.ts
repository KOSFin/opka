import type { TaskWorkflowStore } from './task-workflow-store'
import type { ProjectTaskEntry } from '../../shared/project-task-contract'
import type { DelegationContext } from './task-delegation-policy'

export function reserveProjectTaskLaunch(
  store: TaskWorkflowStore,
  projectId: string,
  task: ProjectTaskEntry,
  runId: string,
  dependencies: ProjectTaskEntry[],
  context: DelegationContext,
  requestId: string,
  payload: unknown
) {
  const receipt = store.delegation.mutate(
    projectId,
    'attempt.launch',
    requestId,
    context.actor.key,
    { revision: task.revision, taskId: task.id, runId, payload },
    () => {
      const reservation = store.prepare(projectId, task, runId, dependencies, context)
      return {
        id: reservation.id,
        operation: 'attempt.launch',
        generation: store.delegation.read(projectId).generation
      }
    }
  )
  const row = store.native.db
    .prepare(
      'SELECT native_task_id FROM project_task_attempts WHERE id=? AND project_id=? AND task_id=?'
    )
    .get(receipt.id, projectId, task.id)
  const nativeTask =
    typeof row?.native_task_id === 'string' ? store.native.getTask(row.native_task_id) : undefined
  if (!nativeTask) {
    throw new Error('Launch reservation is unavailable; inspect its durable receipt')
  }
  return { id: receipt.id, nativeTask, replayed: receipt.replayed }
}
