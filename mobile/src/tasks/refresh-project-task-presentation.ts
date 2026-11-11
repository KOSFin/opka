import type { RpcClient } from '../transport/rpc-client'
import {
  invalidateProjectTaskPresentation,
  type ProjectTaskCatalogRow
} from './project-task-presentation-cache'

export function refreshProjectTaskPresentation(
  client: RpcClient | null,
  hostId: string,
  project: string | null,
  projects: ProjectTaskCatalogRow[],
  selected: string[]
): void {
  if (!client) {
    return
  }
  invalidateProjectTaskPresentation(client, hostId, project)
  if (!project) {
    for (const item of projects) {
      if (selected.includes('*') || selected.includes(item.selector)) {
        invalidateProjectTaskPresentation(client, hostId, item.selector)
      }
    }
  }
}
