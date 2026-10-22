import type { ProjectGroup } from '../../shared/project-group-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

export function mergeFolderProjectGroups<
  Folder extends { projectGroupId: string; folderPath: string },
  Repo extends { projectGroupId?: string | null }
>(
  state: { projectGroups?: ProjectGroup[]; folderWorkspaces?: Folder[]; repos: Repo[] },
  sourceId: string,
  targetId: string
): { merged: boolean; keptGroupId: string } {
  const groups = state.projectGroups ?? []
  const source = groups.find((group) => group.id === sourceId),
    target = groups.find((group) => group.id === targetId)
  if (!source || !target || sourceId === targetId) {
    throw new Error('Choose two existing duplicate project groups')
  }
  if (
    source.parentGroupId ||
    target.parentGroupId ||
    (source.connectionId ?? null) !== (target.connectionId ?? null) ||
    (source.executionHostId ?? 'local') !== (target.executionHostId ?? 'local')
  ) {
    throw new Error('Project groups must be roots on the same host')
  }
  const root = (group: ProjectGroup) => {
    const paths = [
      ...new Set(
        (state.folderWorkspaces ?? [])
          .filter((folder) => folder.projectGroupId === group.id)
          .map((folder) => folder.folderPath)
      )
    ]
    if (paths.length > 1) {
      throw new Error('Group contains multiple project homes; automatic reconciliation is unsafe')
    }
    return paths[0] ?? group.parentPath
  }
  const sourceRoot = root(source),
    targetRoot = root(target)
  if (
    !sourceRoot ||
    !targetRoot ||
    normalizeRuntimePathForComparison(sourceRoot) !== normalizeRuntimePathForComparison(targetRoot)
  ) {
    throw new Error('Project groups do not refer to the same project folder')
  }
  state.projectGroups = groups
    .filter((group) => group.id !== sourceId)
    .map((group) =>
      group.id === targetId
        ? { ...group, parentPath: targetRoot }
        : group.parentGroupId === sourceId
          ? { ...group, parentGroupId: targetId }
          : group
    )
  state.folderWorkspaces = state.folderWorkspaces?.map((folder) =>
    folder.projectGroupId === sourceId ? { ...folder, projectGroupId: targetId } : folder
  )
  state.repos = state.repos.map((repo) =>
    repo.projectGroupId === sourceId ? { ...repo, projectGroupId: targetId } : repo
  )
  return { merged: true, keptGroupId: targetId }
}
