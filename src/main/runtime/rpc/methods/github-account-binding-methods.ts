import { defineMethod } from '../core'
import { listGitHubCloneAccountInventory } from '../../../github/clone-account-inventory'
import {
  BindableAccounts,
  CloneAccounts,
  ValidateAccountBinding
} from '../../../../shared/rpc-contract/github-account-binding-params'

export const GITHUB_ACCOUNT_BINDING_METHODS = [
  defineMethod({
    name: 'github.listCloneAccounts',
    permission: 'workspace',
    params: CloneAccounts,
    handler: (params) =>
      listGitHubCloneAccountInventory(params.url, params.refreshCapability === true)
  }),
  defineMethod({
    name: 'github.listBindableAccounts',
    permission: 'workspace',
    params: BindableAccounts,
    handler: async (params, { runtime }) =>
      runtime.listGitHubBindableAccounts(params.repo, {
        refreshCapability: params.refreshCapability
      })
  }),
  defineMethod({
    name: 'github.validateAccountBinding',
    permission: 'workspace',
    params: ValidateAccountBinding,
    handler: async (params, { runtime }) =>
      runtime.validateGitHubAccountBinding(params.repo, {
        host: params.host,
        user: params.user
      })
  })
]
