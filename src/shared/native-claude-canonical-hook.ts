import { z } from 'zod'
const id = z.string().min(1).max(64)
export const NativeClaudeCanonicalHookSchema = z
  .object({
    nativeOrigin: z.enum(['engine', 'plugin', 'unverifiable']),
    event: z.enum([
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'StopFailure',
      'SubagentStart',
      'SubagentStop',
      'PermissionRequest',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure'
    ]),
    sessionId: z.uuid(),
    promptId: z.uuid().optional(),
    agentId: id.optional(),
    source: z.enum(['startup', 'resume', 'clear', 'compact', 'fork', 'unknown']).optional(),
    toolUseId: z.string().min(1).max(128).optional(),
    toolName: z.string().min(1).max(128).optional(),
    error: z.enum(['rate_limit', 'other']).optional(),
    backgroundTasks: z
      .array(
        z
          .object({
            id: id.optional(),
            type: z.enum([
              'agent',
              'teammate',
              'bash',
              'shell',
              'command',
              'cron',
              'other',
              'unknown'
            ]),
            status: z.enum(['running', 'pending', 'completed', 'failed', 'cancelled', 'unknown'])
          })
          .strict()
      )
      .max(64)
      .optional(),
    backgroundTasksTruncated: z.boolean().optional(),
    sessionCrons: z.array(id).max(64).optional(),
    sessionCronsTruncated: z.boolean().optional()
  })
  .strict()
export type NativeClaudeCanonicalHook = z.infer<typeof NativeClaudeCanonicalHookSchema>
export type NativeClaudeCanonicalHookReceipt = Pick<
  NativeClaudeCanonicalHook,
  'event' | 'sessionId' | 'promptId' | 'agentId'
> & {
  observedAt: number
  backgroundTasksComplete: boolean
  sessionCronsComplete: boolean
}
