import type {
  ProjectTaskDiagnostic,
  ProjectTaskEntry,
  TaskProject
} from '../../shared/project-task-contract'

export function validateTaskGraph(
  project: TaskProject,
  tasks: ProjectTaskEntry[]
): ProjectTaskDiagnostic[] {
  const diagnostics: ProjectTaskDiagnostic[] = []
  const byId = new Map<string, ProjectTaskEntry>()
  for (const task of tasks) {
    if (byId.has(task.id)) {
      diagnostics.push({ path: task.path, message: `Duplicate task ID: ${task.id}` })
    }
    byId.set(task.id, task)
    for (const repo of task.repos) {
      if (!Object.hasOwn(project.repos, repo)) {
        diagnostics.push({ path: task.path, message: `Unknown repository alias: ${repo}` })
      }
    }
  }
  const visited = new Set<string>()
  const visiting = new Set<string>()
  function visit(task: ProjectTaskEntry): void {
    if (visiting.has(task.id)) {
      diagnostics.push({ path: task.path, message: 'Task dependency/parent cycle' })
      return
    }
    if (visited.has(task.id)) {
      return
    }
    visiting.add(task.id)
    for (const id of [...task.depends_on, ...(task.parent ? [task.parent] : [])]) {
      const linked = byId.get(id)
      if (!linked) {
        diagnostics.push({ path: task.path, message: `Missing task reference: ${id}` })
      } else {
        visit(linked)
      }
    }
    visiting.delete(task.id)
    visited.add(task.id)
  }
  for (const task of tasks) {
    visit(task)
  }
  return diagnostics
}
