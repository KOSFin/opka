import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  findFolderWorkspaceCandidateRepos,
  getFolderWorkspaceHostId
} from '../../../../shared/folder-workspace-execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'

export function getFolderProjectRepositories(
  state: {
    folderWorkspaces: readonly FolderWorkspace[]
    projectGroups: readonly ProjectGroup[]
    repos: readonly Repo[]
  },
  folder: FolderWorkspace
): Repo[] {
  const hostId = getFolderWorkspaceHostId(folder, state.projectGroups)
  return findFolderWorkspaceCandidateRepos(
    { ...state, folderWorkspaces: [folder] },
    folder.id
  ).filter((repo) => !isFolderRepo(repo) && getRepoExecutionHostId(repo) === hostId)
}
