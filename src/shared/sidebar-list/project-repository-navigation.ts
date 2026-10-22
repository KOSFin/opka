import type { Repo } from '../repo-types'
import type { ProjectGroup } from '../project-group-types'
import { getRepoExecutionHostId } from '../execution-host'
import {
  getRuntimePathBasename,
  isPathInsideOrEqual,
  relativePathInsideRoot
} from '../cross-platform-path'

export function getRepoProjectSectionId(
  repo: Repo | undefined,
  groups: readonly ProjectGroup[]
): string | null {
  if (!repo?.projectGroupId) {
    return null
  }
  const group = groups.find(
    (entry) =>
      entry.id === repo.projectGroupId &&
      getRepoExecutionHostId(entry) === getRepoExecutionHostId(repo)
  )
  return group ? getSidebarProjectGroupId(group, groups) : repo.projectGroupId
}

export function getSidebarProjectGroupId(
  group: ProjectGroup,
  groups: readonly ProjectGroup[]
): string {
  const seen = new Set<string>()
  let current = group
  while (current.createdFrom === 'folder-scan' && current.parentGroupId && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = groups.find((entry) => entry.id === current.parentGroupId)
    if (
      !parent ||
      getRepoExecutionHostId(parent) !== getRepoExecutionHostId(current) ||
      !parent.parentPath ||
      !current.parentPath ||
      !isPathInsideOrEqual(parent.parentPath, current.parentPath)
    ) {
      break
    }
    current = parent
  }
  return current.id
}

export function getSidebarProjectGroups(groups: readonly ProjectGroup[]): ProjectGroup[] {
  return groups
    .filter((group) => getSidebarProjectGroupId(group, groups) === group.id)
    .map((group) => {
      const parent = groups.find((entry) => entry.id === group.parentGroupId)
      return parent ? { ...group, parentGroupId: getSidebarProjectGroupId(parent, groups) } : group
    })
}

export function getProjectRepositoryLabel(repo: Repo, group: ProjectGroup): string {
  const relative = group.parentPath ? relativePathInsideRoot(group.parentPath, repo.path) : null
  if (!relative) {
    return repo.displayName
  }
  return repo.displayName === getRuntimePathBasename(repo.path)
    ? relative
    : `${repo.displayName} · ${relative}`
}
