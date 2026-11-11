import { z } from 'zod'
import { RepoSelector } from './github-repo-target-params'
import { requiredString } from './rpc-param-primitives'

export const BindableAccounts = RepoSelector.extend({
  refreshCapability: z.boolean().optional()
})

export const CloneAccounts = z.object({
  url: requiredString('Missing HTTPS clone URL'),
  refreshCapability: z.boolean().optional()
})

export const ValidateAccountBinding = RepoSelector.extend({
  host: requiredString('Missing host'),
  user: requiredString('Missing user')
})
