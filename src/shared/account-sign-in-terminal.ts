import { z } from 'zod'
import { parseExecutionHostId, type ExecutionHostId } from './execution-host'

const ExecutionHostIdSchema = z.custom<ExecutionHostId>(
  (value) => typeof value === 'string' && parseExecutionHostId(value) !== null
)

export const ACCOUNT_SIGN_IN_TERMINAL_RUNTIME_CAPABILITY = 'accounts.sign-in-terminal.v1' as const
export const OpenAccountSignInTerminalParams = z
  .object({
    provider: z.literal('claude'),
    worktree: z.string().min(1).max(32_768),
    clientMutationId: z.string().min(1).max(96)
  })
  .strict()
export const AccountSignInTerminalSchema = z
  .object({
    terminal: z
      .object({
        handle: z.string().min(1),
        worktreeId: z.string().min(1),
        tabId: z.string().min(1),
        leafId: z.string().min(1),
        executionHostId: ExecutionHostIdSchema.optional(),
        hostPlatform: z.enum(['darwin', 'linux', 'win32']).optional().catch(undefined)
      })
      .passthrough()
  })
  .strict()
export type AccountSignInTerminal = z.infer<typeof AccountSignInTerminalSchema>
