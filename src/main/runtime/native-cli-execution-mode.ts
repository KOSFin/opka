import type { NativeCliAccountLaunchRequest } from '../../shared/native-cli-account-launch'
import type { OrcaRuntimeService } from './orca-runtime'
import { verifyProjectTaskTerminalProof } from './project-task-terminal-proof'

/** A separate PTY must never replace an already managed task or pane identity. */
export function nativeCliExecutionMode(
  runtime: Pick<OrcaRuntimeService, 'getOrchestrationDispatchAuthority'>,
  params: Pick<
    NativeCliAccountLaunchRequest,
    'interactive' | 'parentTerminal' | 'parentContextExpected'
  >
): 'inherit' | 'host-pty' {
  if (params.parentTerminal) {
    if (!verifyProjectTaskTerminalProof(runtime, params.parentTerminal)) {
      throw new Error(
        'The owning host could not verify the parent terminal; no replacement was created'
      )
    }
    return 'inherit'
  }
  if (!params.interactive) {
    return 'inherit'
  }
  if (params.parentContextExpected) {
    throw new Error(
      'The parent terminal context is unverifiable; no floating replacement was created'
    )
  }
  return 'host-pty'
}
