import type { OrcaRuntimeService } from './orca-runtime'
import { projectTaskResources } from './project-task-workflow-service'
import { projectTaskWorkflow } from '../project-tasks/task-workflow-view'
import { PROJECT_TASK_CONTEXT_MAX_CHARS } from '../../shared/project-task-contract'

export async function resumeProjectTask(runtime: OrcaRuntimeService, worktree: string, id: string) {
  const resources = await projectTaskResources(runtime, worktree)
  const task = await resources.workspace.show(id)
  const workflow = projectTaskWorkflow(resources.store, resources.projectId, task)
  const files = await resources.workspace.context(id)
  const header = `Owning execution host: ${resources.executionHostId}\nRuntime phase: ${workflow.phase}; archived: ${workflow.archived}\nCurrent plan approved: ${workflow.approvedRevision === task.revision}; changed after approval: ${workflow.revisionChanged}\nAttempts (durable history, NOT a liveness check):\n${
    workflow.attempts
      .slice(0, 3)
      .map(
        (attempt) =>
          `${attempt.nativeTaskId}: ${attempt.nativeStatus}; Dispatch ${attempt.dispatchId ?? 'none'}; Run ${attempt.runId}`
      )
      .join('\n') || 'None'
  }\nRecent facts / operator decisions:\n${
    workflow.events
      .slice(0, 5)
      .map((event) => `${event.kind}: ${event.detail.slice(0, 400)}`)
      .join('\n') || 'None'
  }\nNext: inspect the exact previous Dispatch before starting again. Unknown or lost contact is not proof of exit. Accepted work is an operator decision, not verified CI.\n\n`
  const text = header + files.text
  const suffix = '\n[Resume packet truncated; read the task document and exact attempt on demand.]'
  return {
    ...files,
    workflow: {
      ...workflow,
      attempts: workflow.attempts.slice(0, 3),
      events: workflow.events
        .slice(0, 5)
        .map((event) => ({ ...event, detail: event.detail.slice(0, 400) }))
    },
    executionHostId: resources.executionHostId,
    text:
      text.length > PROJECT_TASK_CONTEXT_MAX_CHARS
        ? text.slice(0, PROJECT_TASK_CONTEXT_MAX_CHARS - suffix.length) + suffix
        : text,
    truncated: files.truncated || text.length > PROJECT_TASK_CONTEXT_MAX_CHARS
  }
}
