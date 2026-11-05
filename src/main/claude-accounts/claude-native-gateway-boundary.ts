import type { NativeClaudeCoverageState } from '../../shared/native-claude-coverage'

/** A rejected HTTP attempt may be replaced; this does not certify native turn completion. */
export function readClaudeNativeRejectedRequestBoundary(options: {
  readCoverage: () => NativeClaudeCoverageState | undefined
  readOwner: () => string | null
  activeHttp: () => number
  hasOwedBackgroundWork: () => boolean
}) {
  const held = options.readCoverage(),
    owner = options.readOwner()
  return () => {
    const current = options.readCoverage()
    return (
      !!held &&
      !!owner &&
      options.readOwner() === owner &&
      current === held &&
      options.activeHttp() === 1 &&
      !options.hasOwedBackgroundWork() &&
      !held.unknown &&
      !held.draftUnverifiable &&
      !held.draftActive &&
      held.requests.length === 1 &&
      held.tools.length === 0 &&
      held.spawns.length === 0 &&
      held.pendingTasks.length === 0 &&
      held.liveAgents.length === 0 &&
      held.pendingPrompts.length === 0
    )
  }
}
