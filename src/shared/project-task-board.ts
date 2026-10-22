import type { ProjectTaskEntry, TaskProject, ProjectTaskDiagnostic } from './project-task-contract'
import type { ProjectTaskWorkflow } from './project-task-workflow'

export type ProjectTaskBoardRow = Omit<ProjectTaskEntry, 'body' | 'content'> & {
  workflow: ProjectTaskWorkflow
}
export type ProjectTaskBoard = {
  project: TaskProject
  executionHostId: string
  total: number
  diagnostics: ProjectTaskDiagnostic[]
  tasks: ProjectTaskBoardRow[]
}
