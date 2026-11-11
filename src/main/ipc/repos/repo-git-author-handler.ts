import { ipcMain } from 'electron'
import type { Store } from '../../persistence'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { readRepoGitAuthor, updateRepoGitAuthor } from '../../git/repo-git-author'
import type { RepoGitAuthorUpdate } from '../../../shared/repo-git-author'

type AuthorRepoRequest = { repoId: string; hostId: ExecutionHostId; expectedPath: string }

function authorRepo(store: Store, args: AuthorRepoRequest) {
  const repo = store
    .getRepos()
    .find((entry) => entry.id === args.repoId && getRepoExecutionHostId(entry) === args.hostId)
  if (!repo || repo.path !== args.expectedPath) {
    throw new Error('Git author repository changed on this host. Refresh before continuing.')
  }
  requireReachableGitRoute(getRepoExecutionHostId(repo))
  return repo
}

export function registerRepoGitAuthorHandler(store: Store): void {
  ipcMain.handle('repos:getGitAuthor', (_event, args: AuthorRepoRequest) =>
    readRepoGitAuthor(authorRepo(store, args))
  )
  ipcMain.handle('repos:updateGitAuthor', (_event, args: AuthorRepoRequest & RepoGitAuthorUpdate) =>
    updateRepoGitAuthor(authorRepo(store, args), args)
  )
}
