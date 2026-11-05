import { z } from 'zod'

export const TerminalTaskCallerIdentity = z
  .object({
    terminalHandle: z.string().min(1).max(512),
    paneKey: z.string().min(1).max(1024),
    worktreeId: z.string().min(1).max(4096),
    processIncarnation: z.string().min(1).max(4096)
  })
  .strict()
export const TerminalTaskCallerProof = z.string().regex(/^[a-f0-9]{64}$/)
export const TerminalTaskCallerEvidence = TerminalTaskCallerIdentity.pick({
  terminalHandle: true,
  paneKey: true
})
  .extend({ terminalTaskProof: TerminalTaskCallerProof })
  .strict()
