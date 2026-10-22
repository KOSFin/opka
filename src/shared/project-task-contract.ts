export const PROJECT_TASK_DOCUMENT_MAX_BYTES = 256 * 1024
export const PROJECT_TASK_MAX_COUNT = 1_000
export const PROJECT_TASK_CONTEXT_MAX_CHARS = 8_000
export const PROJECT_TASK_CONFIG_PATH = '.orca/project.yaml'

export type ProjectTaskKind =
  | 'implementation'
  | 'investigation'
  | 'review'
  | 'integration'
  | 'documentation'
  | 'operations'
export type TaskProject = {
  schema: 1
  id: string
  repos: Record<string, string>
  sources: { id: string; path: string }[]
}
export type ProjectTaskDocument = {
  schema: 1
  id: string
  title: string
  kind: ProjectTaskKind
  parent: string | null
  depends_on: string[]
  repos: string[]
  content: string
  body: string
  revision: string
}
export type ProjectTaskEntry = ProjectTaskDocument & { source: string; path: string }
export type ProjectTaskDiagnostic = { path: string; message: string }
export type ProjectTaskSnapshot = {
  project: TaskProject
  tasks: ProjectTaskEntry[]
  diagnostics: ProjectTaskDiagnostic[]
}
export type ProjectTaskContext = {
  projectId: string
  taskId: string
  revision: string
  execution: 'unknown'
  approval: 'unverified'
  checkpoint: { path: string; content: string; freshness: 'unverified' } | null
  text: string
  truncated: boolean
}
