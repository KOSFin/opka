import { retireTerminalTaskCaller } from '../../project-task-terminal-proof'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'

/** Called only after the execution host has certified physical process death. */
export function settleExitedTerminalGeneration(
  runtime: { getExistingOrchestrationDb(): OrchestrationDb | null },
  pty: RuntimePtyWorktreeRecord | undefined,
  ptyId: string,
  exitIncarnationId: string | undefined,
  sshOwned = false
): void {
  if (sshOwned || !pty?.incarnationId || pty.connectionId || pty.isWsl || pty.wslDistro) {
    return
  }
  retireTerminalTaskCaller(ptyId, `${ptyId}:${pty.incarnationId}`)
  // A legacy exit without its own generation must not retire a same-id successor's lease.
  if (exitIncarnationId && exitIncarnationId === pty.incarnationId) {
    runtime.getExistingOrchestrationDb()?.releaseAccountPoolPtyGeneration(ptyId, exitIncarnationId)
  }
}
