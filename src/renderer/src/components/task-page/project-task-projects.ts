import type { ProjectTaskProject } from '../../../../shared/project-task-catalog'
import type { ProjectTaskBoard, ProjectTaskBoardRow } from '../../../../shared/project-task-board'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type TaskProjectScope = ProjectTaskProject & {
  key: string
  hostLabel: string
  target: RuntimeClientTarget
}
export type TaskProjectView = { scope: TaskProjectScope; board: ProjectTaskBoard }
export type TaskViewRow = ProjectTaskBoardRow & {
  viewKey?: string
  projectKey?: string
  projectLabel?: string
}
export const taskViewKey = (task: TaskViewRow): string => task.viewKey ?? task.id
export function taskProjectKey(target: RuntimeClientTarget, root: string): string {
  return JSON.stringify([target.kind === 'local' ? 'local' : target.environmentId, root])
}
export function projectTaskRows(views: TaskProjectView[], showProject: boolean): TaskViewRow[] {
  return views.flatMap(({ scope, board }) =>
    board.tasks.map((task) => ({
      ...task,
      viewKey: JSON.stringify([scope.key, task.id]),
      projectKey: scope.key,
      ...(showProject ? { projectLabel: `${scope.name} · ${scope.hostLabel}` } : {})
    }))
  )
}
export function projectTaskError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/method_not_found|unknown method|method not found|not supported/i.test(message)) {
    return 'This server needs a newer fork version to show project tasks. Update the test server, then refresh.'
  }
  if (/ENOENT|not set up|not configured/i.test(message)) {
    return 'Task files are not set up here. Choose the overall project or set up its task files.'
  }
  if (/connect|timeout|unreachable|offline|disconnected|runtime_unavailable/i.test(message)) {
    return 'Cannot reach this host. Reconnect it, then refresh. Running agents have not been declared stopped.'
  }
  return message
}
