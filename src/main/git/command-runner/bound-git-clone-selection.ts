import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { app } from 'electron'
import type { BoundGitCloneChoice, GitNetworkBinding } from '../../../shared/git-network-binding'
import {
  normalizeGhAccountBinding,
  type GhAccountBinding
} from '../../../shared/github/account-binding'
import { createGitLabNetworkProfileStore } from '../../gitlab/gitlab-network-profile-store'
import { invalidateGhAccountTokenCache, resolveGhAccountToken } from '../../github/gh-account-token'
import { validateGhAccountBinding } from '../../github/gh-account-binding-inventory'
import { desktopCliLauncherPath } from '../../cli/desktop-cli-launcher-path'
import { parseBoundGitCredentialTarget } from './bound-git-credential-target'

export type BoundGitCloneSelection = {
  url: string
  binding: GitNetworkBinding
  launcherPath: string
  readCurrent: () => Promise<boolean>
  readPassword: () => Promise<string>
}

type ProfileStore = Pick<ReturnType<typeof createGitLabNetworkProfileStore>, 'list' | 'readToken'>

export type BoundGitCloneSelectionDependencies = {
  profileStore?: ProfileStore
  launcherPath?: string | null
  validateGitHubAccount?: (account: GhAccountBinding) => Promise<boolean>
  readGitHubToken?: (account: GhAccountBinding) => Promise<string>
}

function unavailable(): Error {
  return new Error('Selected Git network profile is unavailable for this clone.')
}

export async function validateBoundGitCloneSelection(
  url: string,
  choice: BoundGitCloneChoice,
  dependencies: BoundGitCloneSelectionDependencies = {}
): Promise<BoundGitCloneSelection> {
  if (
    !choice ||
    (choice.provider !== 'gitlab' && choice.provider !== 'github') ||
    process.platform === 'win32'
  ) {
    throw unavailable()
  }
  const launcherPath =
    dependencies.launcherPath === undefined
      ? desktopCliLauncherPath({
          platform: process.platform,
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          userDataPath: app.getPath('userData')
        })
      : dependencies.launcherPath
  if (!launcherPath) {
    throw unavailable()
  }
  await access(launcherPath, constants.X_OK).catch(() => {
    throw unavailable()
  })

  if (choice.provider === 'gitlab') {
    if (!/^[a-f0-9]{64}$/.test(choice.profileId)) {
      throw unavailable()
    }
    const profileStore = dependencies.profileStore ?? createGitLabNetworkProfileStore()
    const profile = profileStore.list().find((entry) => entry.id === choice.profileId)
    if (!profile) {
      throw unavailable()
    }
    const target = parseBoundGitCredentialTarget(url, profile.user)
    const targetHost = target.port === '443' ? target.host : `${target.host}:${target.port}`
    if (targetHost !== profile.host) {
      throw unavailable()
    }
    return {
      url,
      binding: { provider: 'gitlab', ...profile },
      launcherPath,
      readCurrent: async () =>
        profileStore
          .list()
          .some(
            (entry) =>
              entry.id === profile.id &&
              entry.host === profile.host &&
              entry.user === profile.user &&
              entry.generation === profile.generation
          ),
      readPassword: async () => profileStore.readToken(profile)
    }
  }

  const account = normalizeGhAccountBinding(choice)
  if (!account) {
    throw unavailable()
  }
  const target = parseBoundGitCredentialTarget(url, account.user)
  const targetHost = target.port === '443' ? target.host : `${target.host}:${target.port}`
  if (targetHost !== account.host) {
    throw unavailable()
  }
  const validate =
    dependencies.validateGitHubAccount ??
    (async (selected: GhAccountBinding) =>
      (await validateGhAccountBinding(selected, {}, { requiredHost: selected.host })).ok)
  if (!(await validate(account))) {
    throw unavailable()
  }
  const binding: GitNetworkBinding = { provider: 'github', ...account, generation: randomUUID() }
  return {
    url,
    binding,
    launcherPath,
    readCurrent: () => validate(account),
    readPassword: async () => {
      if (dependencies.readGitHubToken) {
        return dependencies.readGitHubToken(account)
      }
      invalidateGhAccountTokenCache(account)
      return resolveGhAccountToken(account)
    }
  }
}
