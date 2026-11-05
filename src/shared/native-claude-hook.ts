import { z } from 'zod'

export const NATIVE_CLAUDE_ROUTING_KEY_ENV = 'OPKA_CLAUDE_ROUTING_KEY'
export const NativeClaudeWakeMarker = z
  .string()
  .regex(/^<opka-native-wake:v1:[a-f0-9-]{36}:[12]:[a-f0-9]{64}>$/)
const common = {
  launchId: z.uuid(),
  capability: z.string().min(32).max(256),
  sessionId: z.string().min(1).max(256),
  promptId: z.string().min(1).max(256)
}
export const NativeClaudeHookParams = z.discriminatedUnion('event', [
  z
    .object({
      ...common,
      event: z.literal('prompt'),
      wakeMarker: NativeClaudeWakeMarker.optional()
    })
    .strict(),
  z.object({ ...common, event: z.literal('failure'), error: z.literal('rate_limit') }).strict(),
  z.object({ ...common, event: z.literal('stop') }).strict(),
  z
    .object({
      ...common,
      event: z.literal('claim-wake'),
      phaseId: z.uuid(),
      step: z.union([z.literal(1), z.literal(2)])
    })
    .strict(),
  z
    .object({
      ...common,
      event: z.literal('fresh-wake'),
      wakeMarker: NativeClaudeWakeMarker.optional()
    })
    .strict()
])
export type NativeClaudeHookRequest = z.infer<typeof NativeClaudeHookParams>
export const NativeClaudeHookResult = z.discriminatedUnion('action', [
  z.object({ action: z.literal('allow') }).strict(),
  z.object({ action: z.literal('block') }).strict(),
  z.object({ action: z.literal('none') }).strict(),
  z.object({ action: z.literal('prepared'), phaseId: z.uuid() }).strict(),
  z.object({ action: z.literal('wake'), marker: NativeClaudeWakeMarker }).strict()
])
export type NativeClaudeHookReply = z.infer<typeof NativeClaudeHookResult>
