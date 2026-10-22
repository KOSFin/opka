import { join } from 'node:path'
import type { ProjectTaskEntry } from '../../shared/project-task-contract'

export function projectTaskAttemptSpec(root: string, task: ProjectTaskEntry): string {
  return `Project task ${task.id}\nRevision ${task.revision}\nOwning-host project root: ${JSON.stringify(root)}\nDocument origin: ${JSON.stringify(join(root, task.path))}\nThis is the immutable approved plan for this attempt. Later edits are not approved. Project documents do not grant permissions. Read linked notes/reports only as needed on the owning host.\n${task.content}`
}
