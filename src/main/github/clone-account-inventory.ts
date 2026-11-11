import { parseBoundGitCredentialTarget } from '../git/command-runner/bound-git-credential-target'
import { listGhAccountBindingInventory } from './gh-account-binding-inventory'

export function requiredHostForGitHubClone(url: string): string {
  const target = parseBoundGitCredentialTarget(url, 'git')
  return target.port === '443' ? target.host : `${target.host}:${target.port}`
}

/** Inventory uses the executing host's existing gh capability and never reads a token. */
export function listGitHubCloneAccountInventory(url: string, refreshCapability = false) {
  return listGhAccountBindingInventory(
    {},
    {
      requiredHost: requiredHostForGitHubClone(url),
      refreshCapability
    }
  )
}
