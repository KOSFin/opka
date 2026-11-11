import { OrcaRuntimeWithVerifyOrchestrationCompatibilityCaller } from './orchestration/terminal-authority/verify-orchestration-compatibility-caller'
import type { OrchestrationCompatibilityTerminalAuthority } from './runtime-terminal-contracts'
import { currentNativeCliStartup, type NativeCliStartup } from './native-cli-startup'

export abstract class OrcaRuntimeWithNativeCliStartup extends OrcaRuntimeWithVerifyOrchestrationCompatibilityCaller {
  abstract getOrchestrationDispatchAuthority(
    handle: string
  ): OrchestrationCompatibilityTerminalAuthority | null

  getNativeCliStartupForHandle(handle: string): NativeCliStartup | null {
    const authority = this.getOrchestrationDispatchAuthority(handle)
    if (!authority || authority.hostScope.kind !== 'local') {
      return null
    }
    return currentNativeCliStartup(this.ptysById.get(authority.ptyId))
  }
}
