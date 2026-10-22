import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import type { FolderWorkspace } from '../folder-workspace-types'
import { getRepoExecutionHostId } from '../execution-host'
import { normalizeRuntimePathForComparison } from '../cross-platform-path'
import { getFolderWorkspaceHostId } from '../folder-workspace-execution-host'

/** Old imports can leave empty directory aliases; never hide a group owning real work. */
export function omitEmptyDuplicateProjectGroups(
  groups: readonly ProjectGroup[],
  repos: readonly Repo[],
  folders: readonly FolderWorkspace[]
): readonly ProjectGroup[] {
  const identity = (host: string, id: string): string => JSON.stringify([host, id])
  const byId = new Map(
    groups.map((group) => [identity(getRepoExecutionHostId(group), group.id), group])
  )
  const occupied = new Set<string>()
  const entries = [
    ...repos.map((entry) => ({ ...entry, owner: getRepoExecutionHostId(entry) })),
    ...folders.map((entry) => ({ ...entry, owner: getFolderWorkspaceHostId(entry, groups) }))
  ]
  for (const entry of entries) {
    let id = entry.projectGroupId
    const visited = new Set<string>()
    while (id && !visited.has(id)) {
      visited.add(id)
      const key = identity(entry.owner, id)
      occupied.add(key)
      id = byId.get(key)?.parentGroupId
    }
  }
  const keys = new Map<string, ProjectGroup[]>()
  for (const group of groups) {
    if (group.createdFrom !== 'folder-scan' || !group.parentPath || !group.parentGroupId) {
      continue
    }
    const key = JSON.stringify([
      getRepoExecutionHostId(group),
      group.parentGroupId,
      normalizeRuntimePathForComparison(group.parentPath)
    ])
    const peers = keys.get(key) ?? []
    peers.push(group)
    keys.set(key, peers)
  }
  const hidden = new Set<string>()
  for (const peers of keys.values()) {
    if (peers.length < 2) {
      continue
    }
    const hasWork = (group: ProjectGroup): boolean =>
      occupied.has(identity(getRepoExecutionHostId(group), group.id))
    const retained = peers.find(hasWork) ?? peers[0]
    for (const group of peers) {
      if (group !== retained && !hasWork(group)) {
        hidden.add(identity(getRepoExecutionHostId(group), group.id))
      }
    }
  }
  return hidden.size
    ? groups.filter((group) => !hidden.has(identity(getRepoExecutionHostId(group), group.id)))
    : groups
}
