import type { ProjectTaskWorkflow } from './project-task-workflow'

export function projectTaskNeedsDecision(workflow: ProjectTaskWorkflow): boolean {
  if (workflow.archived) {
    return false
  }
  if (
    workflow.revisionChanged ||
    ['draft', 'review', 'integration'].includes(workflow.phase) ||
    workflow.exportError
  ) {
    return true
  }
  if (workflow.phase !== 'active') {
    return false
  }
  const attempt = workflow.attempts[0]
  return (
    !!attempt &&
    (['failed', 'blocked', 'unknown'].includes(attempt.nativeStatus) ||
      attempt.workerState === null ||
      ['failed', 'stopped', 'abandoned', 'start_unknown', 'stop_unknown'].includes(
        attempt.workerState
      ))
  )
}
