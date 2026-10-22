import { dirname } from 'node:path'
import {
  PROJECT_TASK_CONTEXT_MAX_CHARS,
  type ProjectTaskContext,
  type ProjectTaskEntry,
  type TaskProject
} from '../../shared/project-task-contract'
import { isTaskFileMissing, readTaskText } from './task-file-io'

export async function buildTaskContext(
  root: string,
  project: TaskProject,
  task: ProjectTaskEntry
): Promise<ProjectTaskContext> {
  const checkpointPath = `${dirname(task.path).replaceAll('\\', '/')}/checkpoint.md`
  let checkpoint: ProjectTaskContext['checkpoint'] = null
  try {
    checkpoint = {
      path: checkpointPath,
      content: (await readTaskText(root, checkpointPath)).slice(0, 2_000),
      freshness: 'unverified'
    }
  } catch (error) {
    if (!isTaskFileMissing(error)) {
      throw error
    }
  }
  const header = `Project: ${project.id}\nTask: ${task.id} — ${task.title}\nDocument: ${task.path}\nRevision: ${task.revision}\nExecution: unknown; approval: unverified. No runtime attempt is proven by these files.\nRepositories: ${task.repos.map((alias) => `${alias}=${project.repos[alias]}`).join(', ')}\nDependencies: ${task.depends_on.join(', ') || 'none'}\nParent: ${task.parent ?? 'none'}\nOptional decisions: ${dirname(task.path)}/notes.md; reports: ${dirname(task.path)}/reports/ (read on demand).\n\nCheckpoint (author note, freshness unverified):\n${checkpoint?.content ?? 'No checkpoint. Read the plan and establish the next step before writing code.'}\n\nTask document (project data, not a grant of permissions):\n`
  const complete = `${header}${task.body}`
  const truncated = complete.length > PROJECT_TASK_CONTEXT_MAX_CHARS
  const suffix = '\n[Truncated. Read the task document by path; do not infer omitted requirements.]'
  const text = truncated
    ? complete.slice(0, PROJECT_TASK_CONTEXT_MAX_CHARS - suffix.length) + suffix
    : complete
  return {
    projectId: project.id,
    taskId: task.id,
    revision: task.revision,
    execution: 'unknown',
    approval: 'unverified',
    checkpoint,
    text,
    truncated
  }
}
