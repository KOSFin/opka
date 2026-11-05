import { z } from 'zod'
import { NativeCliShellSetupSchema } from './native-cli-shell-setup'

export const NATIVE_CODEX_ROUTING_CAPABILITY = 'accounts.native-codex-routing.v1' as const
export const NativeCodexRoutingStateSchema = z.object({
  capability: z.literal(NATIVE_CODEX_ROUTING_CAPABILITY),
  supported: z.boolean(),
  shellSetup: NativeCliShellSetupSchema.optional(),
  unavailableReason: z.enum(['platform', 'host-ownership']).optional(),
  accounts: z
    .array(
      z.object({
        accountId: z.uuid(),
        rosterRevision: z.string().min(1).max(512),
        status: z.enum(['needs-sign-in', 'connected', 'ready'])
      })
    )
    .max(256)
})
export type NativeCodexRoutingState = z.infer<typeof NativeCodexRoutingStateSchema>
export const BeginCodexRoutingSignInParams = z
  .object({
    accountId: z.uuid(),
    expectedRosterRevision: z.string().min(1).max(512)
  })
  .strict()
export type CodexRoutingSignInTarget = z.infer<typeof BeginCodexRoutingSignInParams>
