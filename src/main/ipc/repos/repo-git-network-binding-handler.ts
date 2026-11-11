import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../../persistence'
import type { GhAccountBinding } from '../../../shared/github/account-binding'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { RuntimeRepositorySettingsController } from '../../runtime/runtime-repository-settings-controller'
import { notifyReposChanged } from './repos-changed-notification'

type BindingRequest = {
  repoId: string
  hostId: string
  expectedPath: string
  remoteName?: string
}

export function registerRepoGitNetworkBindingHandler(
  mainWindow: BrowserWindow,
  store: Store
): void {
  const bindingController = new RuntimeRepositorySettingsController({
    getStore: () => store,
    resolveRepo: async (selector) => {
      if (typeof selector !== 'string' || !selector.startsWith('id:')) {
        throw new Error('Git network repository selection is invalid.')
      }
      const repo = store
        .getRepos()
        .find(
          (entry) =>
            entry.id === selector.slice(3) &&
            getRepoExecutionHostId(entry) === LOCAL_EXECUTION_HOST_ID
        )
      if (!repo) {
        throw new Error('Git network repository is unavailable on this host.')
      }
      return repo
    },
    forgetTerminalTopology: () => {},
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => notifyReposChanged(mainWindow)
  })
  const checked = (args: BindingRequest): string => {
    if (
      !args ||
      typeof args.repoId !== 'string' ||
      args.hostId !== LOCAL_EXECUTION_HOST_ID ||
      typeof args.expectedPath !== 'string' ||
      (args.remoteName !== undefined && typeof args.remoteName !== 'string')
    ) {
      throw new Error('Git network repository host changed. Refresh before selecting an account.')
    }
    return `id:${args.repoId}`
  }
  ipcMain.handle(
    'repos:bindGitLabNetworkProfile',
    (_event, args: BindingRequest & { profileId: string | null }) =>
      bindingController.bindGitLabNetworkProfile(
        checked(args),
        args.profileId,
        args.remoteName ?? 'origin',
        args.expectedPath
      )
  )
  ipcMain.handle(
    'repos:bindGitHubNetworkAccount',
    (_event, args: BindingRequest & { account: GhAccountBinding | null }) =>
      bindingController.bindGitHubNetworkAccount(
        checked(args),
        args.account,
        args.remoteName ?? 'origin',
        args.expectedPath
      )
  )
}
