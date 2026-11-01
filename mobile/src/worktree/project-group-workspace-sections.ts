import type { ProjectGroup } from '../../../src/shared/project-group-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host'
import { getProjectGroupExecutionHostIdForRows } from '../../../src/shared/sidebar-list/host-filtering'
import { folderWorkspaceRepoId } from '../../../src/shared/folder-workspace-worktree'
import type { Section, SectionRepo } from './workspace-list-types'

/** ProjectGroup membership is separate from durable Project host setups. */
export function groupProjectWorkspaceSections(
  sections: readonly Section[],
  repos: readonly SectionRepo[],
  groups: readonly ProjectGroup[],
  collapsed: ReadonlySet<string>
): Section[] {
  if (groups.length === 0) {
    return sections.map((s) => ({ ...s, data: collapsed.has(s.key) ? [] : s.data }))
  }
  const repoById = new Map(
    repos.map((repo) => [`${getRepoExecutionHostId(repo)}|${repo.id}`, repo])
  )
  const groupByKey = new Map(
    groups.map((group) => [
      `${getProjectGroupExecutionHostIdForRows(group, LOCAL_EXECUTION_HOST_ID)}|${group.id}`,
      group
    ])
  )
  const grouped = new Map<ProjectGroup, Section[]>()
  const order: (Section | ProjectGroup)[] = []
  for (const section of sections) {
    const repo =
      section.repo &&
      (repoById.get(`${getRepoExecutionHostId(section.repo)}|${section.repo.id}`) ?? section.repo)
    const host = repo
      ? getRepoExecutionHostId(repo)
      : (section.data[0]?.hostId ?? LOCAL_EXECUTION_HOST_ID)
    const group = repo?.projectGroupId
      ? groupByKey.get(`${host}|${repo.projectGroupId}`)
      : groups.find(
          (entry) =>
            section.repo?.id === folderWorkspaceRepoId(entry.id) &&
            getProjectGroupExecutionHostIdForRows(entry, LOCAL_EXECUTION_HOST_ID) === host
        )
    if (!group) {
      order.push(section)
      continue
    }
    let children = grouped.get(group)
    if (!children) {
      children = []
      grouped.set(group, children)
      order.push(group)
    }
    children.push(section)
  }
  return order.flatMap((entry): Section[] => {
    if ('data' in entry) {
      return [{ ...entry, data: collapsed.has(entry.key) ? [] : entry.data }]
    }
    const children = grouped.get(entry) ?? []
    const key = `project-group:${getProjectGroupExecutionHostIdForRows(entry, LOCAL_EXECUTION_HOST_ID)}:${entry.id}`
    const folder = children.filter((s) => s.repo?.id === folderWorkspaceRepoId(entry.id))
    const header: Section = {
      key,
      title: entry.name,
      projectGroupHeader: true,
      count: children.reduce((total, s) => total + (s.count ?? s.data.length), 0),
      data: collapsed.has(key) ? [] : folder.flatMap((s) => s.data)
    }
    return [
      header,
      ...(collapsed.has(key)
        ? []
        : children
            .filter((s) => !folder.includes(s))
            .map((s) => ({ ...s, headerDepth: 1, data: collapsed.has(s.key) ? [] : s.data })))
    ]
  })
}
