import { z } from 'zod'

const TurnMetadata = z.object({
  thread_id: z.string().min(1).max(200),
  turn_id: z.string().min(1).max(200),
  root_turn_id: z.string().min(1).max(200).optional(),
  parent_thread_id: z.string().min(1).max(200).optional(),
  thread_source: z.string().min(1).max(200).optional()
})

export type CodexRequestTurnIdentity = {
  threadId: string
  turnId: string
  rootTurnId?: string
  parentThreadId?: string
  auxiliary?: true
}

/** Missing metadata never proves that a previous user turn has finished. */
export function readCodexRequestTurnIdentity(
  header: string | string[] | undefined
): CodexRequestTurnIdentity | undefined {
  if (typeof header !== 'string' || Buffer.byteLength(header) > 16_384) {
    return undefined
  }
  try {
    const metadata = TurnMetadata.safeParse(JSON.parse(header))
    if (!metadata.success) {
      return undefined
    }
    const value = metadata.data
    return {
      threadId: value.thread_id,
      ...(value.thread_source === 'thread_title' ? { auxiliary: true as const } : {}),
      turnId: value.turn_id,
      ...(value.root_turn_id ? { rootTurnId: value.root_turn_id } : {}),
      ...(value.parent_thread_id ? { parentThreadId: value.parent_thread_id } : {})
    }
  } catch {
    return undefined
  }
}
