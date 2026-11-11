// Older hosts require a nonempty review detail for every decision.
export const projectTaskAcceptedDetail = 'Operator accepted the reviewed result.'

export type ProjectTaskPhase = 'draft' | 'ready' | 'active' | 'review' | 'integration' | 'done'
export type ProjectTaskEvent = {
  sequence: number
  taskId: string
  revision: string
  kind: string
  detail: string
  createdAt: string
}
export type ProjectTaskAttempt = {
  id: string
  nativeTaskId: string
  runId: string
  revision: string
  createdAt: string
  dispatchId: string | null
  nativeStatus: string
  workerState: string | null
  terminal: string | null
  session?: {
    address?: string | null
    released?: boolean
    checkpointPath: string | null
    reportPath: string | null
    blocker: string | null
  } | null
}
export type ProjectTaskWorkflow = {
  taskId: string
  phase: ProjectTaskPhase
  archived: boolean
  approvedRevision: string | null
  revisionChanged: boolean
  attempts: ProjectTaskAttempt[]
  events: ProjectTaskEvent[]
  exportError: string | null
  recordedSequence: number
  authorization?: {
    schema: 1
    admission: {
      eligible: boolean
      source: string
      revision: string
      receiptId: string | null
      generation: number | null
      reason: string | null
    }
    continuation: {
      eligible: boolean
      authorizedRevision: string | null
      ownerBinding: string | null
    }
    acceptance: { accepted: boolean; revision: string; resultDigest: string | null }
  }
}
