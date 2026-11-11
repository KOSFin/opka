import type {
  AgentLaunchPaneAddress,
  AgentLaunchPaneVerdict
} from '../../shared/agent-launch-pane-verdict'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import type { OrcaRuntimeService } from './orca-runtime'
import { agentLaunchPaneStartupVerdict } from '../agent-launch/agent-launch-pane-attachment'

export function reportNativeCliStartupPaneVerdict(
  runtime: Pick<OrcaRuntimeService, 'getTerminalHandleForPaneKey' | 'getNativeCliStartupForHandle'>,
  notifier: Pick<RuntimeNotifier, 'agentLaunchPaneVerdict'> | null,
  pane: AgentLaunchPaneAddress,
  verdict: AgentLaunchPaneVerdict
): void {
  const paneKey = `${pane.tabId}:${pane.leafId}`
  const deferred =
    verdict.kind === 'proceed'
      ? agentLaunchPaneStartupVerdict({ worktreeId: pane.worktreeId, paneKey })
      : null
  if (!deferred) {
    notifier?.agentLaunchPaneVerdict?.({ ...pane, verdict })
    return
  }
  const handle = runtime.getTerminalHandleForPaneKey(paneKey)
  const startup = handle ? runtime.getNativeCliStartupForHandle(handle) : null
  void deferred.then((outcome) => {
    if (handle && startup && runtime.getNativeCliStartupForHandle(handle) !== startup) {
      return
    }
    notifier?.agentLaunchPaneVerdict?.({ ...pane, verdict: outcome })
  })
}
