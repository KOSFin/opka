import type { ProjectTaskWorkflow } from './project-task-workflow'

export function projectTaskNeedsDecision(workflow: ProjectTaskWorkflow): boolean {
  if (workflow.archived) {
    return false
  }
  if (
    workflow.revisionChanged ||
    ['draft', 'review', 'integration'].includes(workflow.phase) ||
    workflow.exportError ||
    workflow.attempts[0]?.session?.blocker
  ) {
    return true
  }
  if (workflow.phase !== 'active') {
    return false
  }
  const attempt = workflow.attempts[0]
  if (attempt?.session) {
    return ['failed', 'blocked', 'unknown'].includes(attempt.nativeStatus)
  }
  return (
    !!attempt &&
    (['failed', 'blocked', 'unknown'].includes(attempt.nativeStatus) ||
      attempt.workerState === null ||
      ['failed', 'stopped', 'abandoned', 'start_unknown', 'stop_unknown'].includes(
        attempt.workerState
      ))
  )
}

export function projectTaskNextAction(workflow: {
  archived: boolean
  revisionChanged: boolean
  phase: string
  exportError?: string | null
  attempts: readonly {
    nativeStatus: string
    workerState?: string | null
    session?: { blocker: string | null } | null
  }[]
}): string | null {
  if (workflow.archived) {
    return null
  }
  if (workflow.revisionChanged) {
    return 'Review the changed plan before dispatching again'
  }
  if (workflow.exportError) {
    return 'Retry the task export'
  }
  if (workflow.attempts[0]?.session?.blocker) {
    return 'Review the blocker and provide the missing decision'
  }
  if (workflow.phase === 'draft') {
    return 'Review and approve the plan'
  }
  if (workflow.phase === 'review' || workflow.phase === 'integration') {
    return 'Review the report and record a decision'
  }
  if (
    workflow.phase === 'active' &&
    (['failed', 'blocked', 'unknown'].includes(workflow.attempts[0]?.nativeStatus ?? '') ||
      workflow.attempts[0]?.workerState === null ||
      ['failed', 'stopped', 'abandoned', 'start_unknown', 'stop_unknown'].includes(
        workflow.attempts[0]?.workerState ?? ''
      ))
  ) {
    return 'Inspect the attempt and decide how to resume'
  }
  return null
}
