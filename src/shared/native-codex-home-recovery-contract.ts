import { z } from 'zod'

export const NativeCodexHomeProfileParams = z
  .object({
    profile: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional()
  })
  .strict()

export const CodexNativeHomeRecoveryRequestSchema = z.object({
  version: z.literal(1),
  requestId: z.string().uuid(),
  file: z.string().regex(/^(?:config|[A-Za-z0-9_-]{1,128}\.config)\.toml$/),
  expectedManifestHash: z.string().length(64),
  expectedSourceHash: z.string().length(64),
  expectedOwnedHash: z.string().length(64),
  choices: z
    .object({
      model: z.enum(['source', 'owned']).optional(),
      model_reasoning_effort: z.enum(['source', 'owned']).optional(),
      service_tier: z.enum(['source', 'owned']).optional()
    })
    .strict(),
  trustedProjects: z.array(z.string().max(8192)).max(16)
})

export const NativeCodexHomeRecoveryApplyParams = NativeCodexHomeProfileParams.extend({
  request: CodexNativeHomeRecoveryRequestSchema
})

export type CodexNativeHomeRecoveryRequest = z.infer<typeof CodexNativeHomeRecoveryRequestSchema>
