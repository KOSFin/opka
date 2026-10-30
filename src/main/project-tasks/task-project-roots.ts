import { realpath } from 'node:fs/promises'
import { relative, isAbsolute, sep } from 'node:path'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { ProjectTaskProject, ProjectTaskCatalog } from '../../shared/project-task-catalog'
import { PROJECT_TASK_CONFIG_PATH } from '../../shared/project-task-contract'
import { readTaskText, isTaskFileMissing } from './task-file-io'
import { parseTaskProject } from './task-document'

export type TaskProjectRootsHost = {
  listVisibleFolderWorkspaces(): Pick<
    FolderWorkspace,
    | 'id'
    | 'name'
    | 'folderPath'
    | 'projectGroupId'
    | 'isArchived'
    | 'connectionId'
    | 'executionHostId'
  >[]
  listVisibleRepos(): Pick<
    Repo,
    'id' | 'path' | 'displayName' | 'connectionId' | 'executionHostId'
  >[]
  listVisibleProjectGroups(): Pick<
    ProjectGroup,
    'id' | 'name' | 'connectionId' | 'executionHostId'
  >[]
}

export function taskRootContains(parent: string, child: string): boolean {
  const suffix = relative(parent, child)
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

export function registeredTaskRoots(host: TaskProjectRootsHost) {
  const groups = host.listVisibleProjectGroups()
  const folders = host
    .listVisibleFolderWorkspaces()
    .filter((folder) => {
      const group = groups.find((entry) => entry.id === folder.projectGroupId)
      return (
        !folder.isArchived &&
        !folder.connectionId &&
        (!folder.executionHostId || folder.executionHostId === 'local') &&
        !group?.connectionId &&
        (!group?.executionHostId || group.executionHostId === 'local') &&
        folder.folderPath
      )
    })
    .map((folder) => ({
      selector: `folder:${folder.id}`,
      root: folder.folderPath,
      name: groups.find((group) => group.id === folder.projectGroupId)?.name || folder.name
    }))
  const repos = host
    .listVisibleRepos()
    .filter(
      (repo) => !repo.connectionId && (!repo.executionHostId || repo.executionHostId === 'local')
    )
    .map((repo) => ({
      selector: `path:${repo.path}`,
      root: repo.path,
      name: repo.displayName || repo.path
    }))
  const roots = new Map<string, { selector: string; root: string; name: string }>()
  for (const entry of [...folders, ...repos]) {
    if (!roots.has(entry.root)) {
      roots.set(entry.root, entry)
    }
  }
  return [...roots.values()]
}

async function inspectTaskRoot(entry: {
  selector: string
  root: string
  name: string
}): Promise<ProjectTaskProject> {
  try {
    const root = await realpath(entry.root)
    try {
      const project = parseTaskProject(await readTaskText(root, PROJECT_TASK_CONFIG_PATH))
      return { ...entry, root, state: 'configured', projectId: project.id }
    } catch (error) {
      if (isTaskFileMissing(error)) {
        return { ...entry, root, state: 'unconfigured' }
      }
      throw error
    }
  } catch (error) {
    return {
      ...entry,
      state: 'unavailable',
      message: error instanceof Error ? error.message : 'Project folder unavailable'
    }
  }
}

export async function readTaskProjectCatalog(
  host: TaskProjectRootsHost
): Promise<ProjectTaskCatalog> {
  const roots = registeredTaskRoots(host)
  const projects: ProjectTaskProject[] = []
  // Bound filesystem work to registered homes, never scan arbitrary ancestors or Markdown.
  for (const entry of roots.slice(0, 256)) {
    projects.push(await inspectTaskRoot(entry))
  }
  return {
    truncated: roots.length > 256,
    projects: projects.filter(
      (entry, index) =>
        projects.findIndex((candidate) => candidate.root === entry.root) === index &&
        (entry.state === 'configured' ||
          !projects.some(
            (parent) => parent.root !== entry.root && taskRootContains(parent.root, entry.root)
          ))
    )
  }
}

export async function resolveRegisteredTaskRoot(
  host: TaskProjectRootsHost,
  selectedRoot: string,
  repoId?: string
): Promise<string> {
  // A linked checkout shares its repository's board, including copied task configuration.
  const repo = repoId && host.listVisibleRepos().find((entry) => entry.id === repoId)
  if (repo && !repo.connectionId && (!repo.executionHostId || repo.executionHostId === 'local')) {
    return resolveRegisteredTaskRoot(host, repo.path)
  }
  const selected = await realpath(selectedRoot)
  try {
    await readTaskText(selected, PROJECT_TASK_CONFIG_PATH)
    return selected
  } catch (error) {
    if (!isTaskFileMissing(error)) {
      throw error
    }
  }
  const parents: ReturnType<typeof registeredTaskRoots> = []
  for (const entry of registeredTaskRoots(host).slice(0, 256)) {
    let root: string
    try {
      root = await realpath(entry.root)
    } catch {
      continue
    }
    if (root !== selected && taskRootContains(root, selected)) {
      parents.push({ ...entry, root })
    }
  }
  parents.sort((a, b) => b.root.length - a.root.length)
  for (const parent of parents) {
    const inspected = await inspectTaskRoot(parent)
    if (inspected.state === 'configured' && taskRootContains(inspected.root, selected)) {
      return inspected.root
    }
    if (inspected.state === 'unavailable') {
      throw new Error(
        'The project task configuration could not be read. Check its file permissions and format.'
      )
    }
  }
  return selected
}
