import type { OrcaRuntimeService } from './orca-runtime'

export function bindAccountPoolPtyExecution(
  runtime: Pick<
    OrcaRuntimeService,
    'getOrchestrationDb' | 'getPtyExecutionHostMetadata' | 'subscribeToPtyExit'
  >,
  ownerKey: string,
  ptyId: string,
  incarnationId?: string,
  release?: () => void
): void {
  const db = runtime.getOrchestrationDb()
  db.bindAccountPoolAssignmentPty({ ownerKey, ptyId, incarnationId })
  let settled = false
  let unsubscribe: (() => void) | undefined
  unsubscribe = runtime.subscribeToPtyExit(ptyId, () => {
    if (
      !incarnationId ||
      runtime.getPtyExecutionHostMetadata(ptyId).incarnationId === incarnationId
    ) {
      if (release) {
        release()
      } else {
        db.releaseAccountPoolAssignment(ownerKey)
      }
    }
    settled = true
    unsubscribe?.()
  })
  if (settled) {
    unsubscribe()
  }
}
