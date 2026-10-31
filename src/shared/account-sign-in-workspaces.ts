import { z } from 'zod'

export const AccountSignInWorkspacesSchema = z.object({
  worktrees: z.array(
    z.object({ id: z.string().min(1), displayName: z.string(), path: z.string() })
  ),
  truncated: z.boolean().optional()
})
export type AccountSignInWorkspace = z.infer<
  typeof AccountSignInWorkspacesSchema
>['worktrees'][number]
