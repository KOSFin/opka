import type { OrchestrationDb } from '../runtime/orchestration/db'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'

export function assertProjectTaskNativeAdmission(
  db: OrchestrationDb,
  taskId: string | undefined,
  receipt: { nativeTaskId: string; attemptId: string } | undefined
): void {
  if (!taskId) {
    return
  }
  const binding = db.db
    .prepare('SELECT id FROM project_task_attempts WHERE native_task_id=?')
    .get(taskId)
  if (!binding) {
    return
  }
  if (receipt?.nativeTaskId !== taskId || receipt.attemptId !== binding.id) {
    throw new OrchestrationError(
      'project_task_admission_required',
      'This native Task belongs to a file-backed project task. Use project-task start with the approved revision; direct worker-start/retry cannot bypass its admission.',
      { effectsApplied: false }
    )
  }
}
