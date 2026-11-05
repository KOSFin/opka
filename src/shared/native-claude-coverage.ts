import { z } from 'zod'
import { NativeClaudeCanonicalHookSchema } from './native-claude-canonical-hook'
import { NativeClaudeWakeMarker } from './native-claude-hook'

const id = z.string().min(1).max(256)
const task = z.object({ id, kind: z.enum(['agent', 'shell']) }).strict()
const agent = z.object({ id, status: z.string().min(1).max(32) }).strict()
export const NativeClaudeCoverageEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('canonical-hook'), hook: NativeClaudeCanonicalHookSchema }).strict(),
  z.object({ kind: z.literal('control-failed') }).strict(),
  z
    .object({
      kind: z.literal('prompt'),
      origin: z.string().min(1).max(64),
      submissionId: id.optional(),
      meta: z.boolean().optional(),
      wakeMarker: NativeClaudeWakeMarker.optional(),
      taskId: id.optional(),
      taskStatus: z.string().max(32).optional()
    })
    .strict(),
  z.object({ kind: z.literal('draft'), active: z.boolean() }).strict(),
  z.object({ kind: z.literal('prompt-end'), id, dropped: z.boolean() }).strict(),
  z.object({ kind: z.literal('turn-start'), id, agentId: id.optional() }).strict(),
  z
    .object({
      kind: z.literal('lost'),
      stage: z
        .enum([
          'draft',
          'draft-read',
          'prompt',
          'tool',
          'spawn',
          'turn-start',
          'request',
          'aux',
          'turn-end',
          'stop'
        ])
        .optional()
    })
    .strict(),
  z.object({ kind: z.literal('complete-stop'), promptId: id }).strict(),
  z.object({ kind: z.literal('tool-start'), id, tool: id, agentId: id.optional() }).strict(),
  z
    .object({ kind: z.literal('tool-end'), id, task: task.optional(), agentId: id.optional() })
    .strict(),
  z.object({ kind: z.literal('spawn-start'), id }).strict(),
  z
    .object({
      kind: z.literal('spawn-end'),
      id,
      agentId: id.optional(),
      parentAgentId: id.optional()
    })
    .strict(),
  z.object({ kind: z.literal('request-start'), id, mainTurnId: id.optional() }).strict(),
  z.object({ kind: z.literal('request-end'), id }).strict(),
  z
    .object({
      kind: z.literal('turn-end'),
      id,
      agentId: id.optional(),
      reason: z.enum(['answer', 'aborted', 'refusal', 'error']),
      agents: z.array(agent).max(256)
    })
    .strict()
])
export type NativeClaudeCoverageObservation = z.infer<typeof NativeClaudeCoverageEvent>
export const NativeClaudeCoverageParams = z
  .object({
    launchId: z.uuid(),
    capability: z.string().min(32).max(256),
    sessionId: id,
    generation: z.uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    observation: NativeClaudeCoverageEvent
  })
  .strict()
export type NativeClaudeCoverageRequest = z.infer<typeof NativeClaudeCoverageParams>
export const NativeClaudeCoverageResult = z
  .object({
    sequence: z.number().int().positive(),
    healthy: z.boolean(),
    drop: z.boolean().optional()
  })
  .strict()
export type NativeClaudeCoverageAck = z.infer<typeof NativeClaudeCoverageResult>

/** Private continuity evidence lives on the canonical lead record; it is never a second status row. */
export type NativeClaudeCoverageState = {
  launchId: string
  sessionId: string
  generation: string
  sequence: number
  lastEvent: string
  unknown: boolean
  unknownSince?: number
  sealedStop?: {
    promptId: string
    observedAt: number
    turnId?: string
    reason?: 'answer' | 'aborted' | 'refusal' | 'error'
  }
  tools: string[]
  spawns: string[]
  requests: string[]
  pendingTasks: { id: string; kind: 'agent' | 'shell'; notificationOwed?: true }[]
  liveAgents: string[]
  settledTasks: string[]
  draftActive: boolean
  draftUnverifiable?: true
  pendingPrompts: string[]
  currentMainTurnId?: string
  currentMainPromptId?: string
  mainTurn?: { id: string; reason: 'answer' | 'aborted' | 'refusal' | 'error' }
}
export {
  foldNativeClaudeCoverage,
  isNativeClaudeCoverageQuiet,
  isNativeClaudeCoverageSettled
} from './native-claude-coverage-fold'
