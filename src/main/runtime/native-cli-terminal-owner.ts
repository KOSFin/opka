import type { NativeCliAccountLaunchRequest } from '../../shared/native-cli-account-launch'
import type { OrcaRuntimeService } from './orca-runtime'
import { verifyProjectTaskTerminalProof } from './project-task-terminal-proof'
import { nativeCliTerminalBindings } from './native-cli-terminal-bindings'

export type NativeCliTerminalOwner = { paneKey: string; ptyId: string; incarnationId: string }
type Runtime = Pick<OrcaRuntimeService, 'getOrchestrationDispatchAuthority' | 'resolveTerminalPane'>

/** Capture the proven parent once; a replacement pane never inherits its account capability. */
export function createNativeCliTerminalOwnerReader(
  runtime: Runtime,
  params: NativeCliAccountLaunchRequest
) {
  const verified = params.parentTerminal
    ? verifyProjectTaskTerminalProof(runtime, params.parentTerminal)
    : null
  if (params.parentTerminal && !verified) {
    throw new Error('The owning terminal proof changed before native routing.')
  }
  return (): NativeCliTerminalOwner | null => {
    try {
      const external = verified
        ? undefined
        : nativeCliTerminalBindings(runtime).get(params.launchId)
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
      const pane = runtime.resolveTerminalPane(
        paneKey,
        authority?.worktreeId ?? external?.worktreeId
      )
      if (authority && pane.ptyId !== authority.ptyId) {
        return null
      }
      const incarnation = verified?.processIncarnation ?? external?.incarnationId
      return pane.connected &&
        pane.executionHostId === 'local' &&
        pane.ptyId &&
        pane.incarnationId === incarnation &&
        incarnation
        ? { paneKey, ptyId: pane.ptyId, incarnationId: incarnation }
        : null
    } catch {
      return null
    }
  }
}
