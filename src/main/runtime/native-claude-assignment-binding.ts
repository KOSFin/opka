import type { OrchestrationDb } from './orchestration/db/orchestration-db'
import type { NativeCliTerminalOwner } from './native-cli-terminal-owner'

/** Bind each new assignment once to the unchanged physical native owner. */
export function createNativeClaudeAssignmentBinding(options: {
  db: OrchestrationDb
  readOwner: () => NativeCliTerminalOwner | null
  assertExclusive: () => void
}) {
  let bound: string | undefined
  return (selection: { ownerKey?: string }) => {
    const owner = options.readOwner()
    if (selection.ownerKey && owner) {
      const stamp = `${selection.ownerKey}:${owner.ptyId}:${owner.incarnationId}`
      if (bound === stamp) {
        return
      }
      options.assertExclusive()
      options.db.bindAccountPoolAssignmentPty({
        ownerKey: selection.ownerKey,
        ptyId: owner.ptyId,
        incarnationId: owner.incarnationId
      })
      bound = stamp
    }
  }
}
