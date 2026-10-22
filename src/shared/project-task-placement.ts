import type { ProjectTaskDocument, TaskProject } from './project-task-contract'

export function projectTaskRepositories(
  task: Pick<ProjectTaskDocument, 'repos'>,
  project: TaskProject
): string[] {
  return task.repos.length ? task.repos : Object.keys(project.repos)
}
