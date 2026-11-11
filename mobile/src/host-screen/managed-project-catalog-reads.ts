import type { ProjectGroup } from '../../../src/shared/project-group-types'
import type { RpcClient } from '../transport/rpc-client'
import { hostProjectGroupsRead } from '../worktree/project-sections-operations'
import { hostRepoCatalogRead } from './host-screen-operations'
import type { HostRepoCatalogRow } from './host-screen-reply-schema'

export async function readManagedProjectGroups(client: RpcClient): Promise<ProjectGroup[]> {
  const result = hostProjectGroupsRead.interpret(await hostProjectGroupsRead.request(client))
  if (!result.accepted) {
    throw new Error('This host does not support project settings. Update the host.')
  }
  return result.value
}

export async function readManagedProjectRepos(client: RpcClient): Promise<HostRepoCatalogRow[]> {
  const result = hostRepoCatalogRead.interpret(await hostRepoCatalogRead.request(client))
  if (!result.accepted) {
    throw new Error('This host does not support project moves. Update the host.')
  }
  return result.value
}
