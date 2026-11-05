import { z } from 'zod'
import { NativeCliShellSetupSchema } from './native-cli-shell-setup'
import { isClaudeHostedNativeSignInLink } from './claude-native-sign-in-link'

export const NativeClaudeRefreshSourceState = z.enum([
  'ready',
  'needs-sign-in',
  'signing-in',
  'unverifiable',
  'unsupported'
])
export const NativeClaudeRefreshSourceStatus = z
  .object({
    accountId: z.string().min(1).max(256),
    state: NativeClaudeRefreshSourceState,
    nativeVersion: z.string().max(40).optional()
  })
  .strict()
export type NativeClaudeRefreshSourceStatus = z.infer<typeof NativeClaudeRefreshSourceStatus>
export const NativeClaudeRefreshSourcesResult = z.object({
  accounts: z.array(NativeClaudeRefreshSourceStatus).max(128),
  shellSetup: NativeCliShellSetupSchema.optional()
})
export const NativeClaudeRefreshSourceAccountParams = z
  .object({ accountId: z.string().min(1).max(256) })
  .strict()
export const NativeClaudeRefreshSignInReference = z
  .object({ accountId: z.string().min(1).max(256), signInId: z.uuid() })
  .strict()
export type NativeClaudeRefreshSignInReference = z.infer<typeof NativeClaudeRefreshSignInReference>
export const NativeClaudeRefreshSignInCodeParams = NativeClaudeRefreshSignInReference.extend({
  code: z.string().min(1).max(4096)
}).strict()
export const NativeClaudeRefreshSignInLinkResult = z
  .object({
    link: z
      .string()
      .max(16384)
      .refine(isClaudeHostedNativeSignInLink, 'Native authorization link is unavailable.')
      .nullable(),
    state: NativeClaudeRefreshSourceState,
    requiresCode: z.literal(true).optional()
  })
  .strict()
