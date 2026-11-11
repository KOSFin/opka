import type {
  GhAccountBindingInventory,
  GhAccountBindingValidationResult
} from '../../shared/github/auth-types'

export type GithubAccountApi = {
  listCloneAccounts: (args: {
    url: string
    refreshCapability?: boolean
  }) => Promise<GhAccountBindingInventory>
  listBindableAccounts: (args: {
    repoPath: string
    repoId?: string
    refreshCapability?: boolean
  }) => Promise<GhAccountBindingInventory>
  validateAccountBinding: (args: {
    repoPath: string
    repoId?: string
    host: string
    user: string
  }) => Promise<GhAccountBindingValidationResult>
}
