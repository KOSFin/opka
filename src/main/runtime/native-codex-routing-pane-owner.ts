import type { NativeCodexRoutingRuntime } from './native-codex-routing-launch'
import type { NativeCodexPtyOwner } from './native-codex-routing-ownership'
import type { verifyProjectTaskTerminalProof } from './project-task-terminal-proof'
import { nativeCliTerminalBindings } from './native-cli-terminal-bindings'

export function readNativeCodexRoutingPaneOwner(
  runtime: NativeCodexRoutingRuntime,
  launchId: string,
  verified: ReturnType<typeof verifyProjectTaskTerminalProof>
): NativeCodexPtyOwner | null {
  try {
    const external = verified ? undefined : nativeCliTerminalBindings(runtime).get(launchId)
    const authority = verified
      ? runtime.getOrchestrationDispatchAuthority(verified.terminalHandle)
      : null
    const paneKey = verified?.paneKey ?? external?.paneKey
    if (
      !paneKey ||
      external?.ended ||
      (verified &&
        (!authority ||
          authority.hostScope.kind !== 'local' ||
          authority.paneKey !== paneKey ||
          authority.processIncarnation !== verified.processIncarnation))
    ) {
      return null
    }
    const pane = runtime.resolveTerminalPane(paneKey, authority?.worktreeId ?? external?.worktreeId)
    if (authority && pane.ptyId !== authority.ptyId) {
      return null
    }
    const incarnation = verified ? pane.incarnationId : external?.incarnationId
    return pane.connected &&
      pane.executionHostId === 'local' &&
      pane.ptyId &&
      pane.incarnationId === incarnation &&
      (!verified || authority?.processIncarnation === `${pane.ptyId}:${incarnation}`) &&
      incarnation
      ? { paneKey, ptyId: pane.ptyId, incarnationId: incarnation }
      : null
  } catch {
    return null
  }
}
