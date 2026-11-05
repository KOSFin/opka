import { z } from 'zod'

export const NativeCliShellSetupSchema = z
  .object({
    supported: z.boolean(),
    state: z.enum(['not-installed', 'installed', 'modified', 'unverifiable', 'unsupported']),
    missing: z.array(z.enum(['claude', 'codex', 'orca'])).max(3)
  })
  .strict()
export type NativeCliShellSetup = z.infer<typeof NativeCliShellSetupSchema>

export function nativeCliShellSetupInstalled(setup: NativeCliShellSetup): boolean {
  return setup.supported && setup.state === 'installed' && setup.missing.length === 0
}
