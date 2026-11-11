export type ProjectTaskProject = {
  selector: string
  name: string
  root: string
  state: 'configured' | 'unconfigured' | 'unavailable'
  projectId?: string
  message?: string
  groupId?: string
  groupName?: string
  repositoryName?: string
  projectGroupsAvailable?: boolean
}

export type ProjectTaskCatalog = {
  projects: ProjectTaskProject[]
  truncated: boolean
}
