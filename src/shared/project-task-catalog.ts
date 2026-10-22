export type ProjectTaskProject = {
  selector: string
  name: string
  root: string
  state: 'configured' | 'unconfigured' | 'unavailable'
  projectId?: string
  message?: string
}

export type ProjectTaskCatalog = {
  projects: ProjectTaskProject[]
  truncated: boolean
}
