import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export type StructuredAccountAcquisition = {
  record: AgentSessionRecord
  /** Only a proven pre-spawn refusal permits returning this reservation. */
  preSpawnFailed?: () => void | Promise<void>
}
export type NativeAccountRotationBoundary = {
  lastCompletedTurn: { id: string; outcome: 'success' | 'failure' } | null
  childrenSettled: boolean
  assertCurrent?: () => void
  canRest?: boolean
  canRotate: boolean
}
export type PrepareStructuredAccountAcquisition = (
  record: AgentSessionRecord,
  boundary?: NativeAccountRotationBoundary
) => Promise<StructuredAccountAcquisition>
export type StructuredAccountAcquisitionExited = (identity: {
  sessionId: string
  fence: number
  generation: string | null
  spawnToken: string | null
}) => void | Promise<void>
