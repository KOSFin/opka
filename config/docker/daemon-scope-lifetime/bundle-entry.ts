import { ownFreshDaemonScope } from '../../../src/main/daemon/daemon-cgroup-scope'
import { startDaemonScopeDeathWatch } from '../../../src/main/daemon/daemon-scope-death-watch'
import { initializeTerminalScopes } from '../../../src/main/daemon/terminal-scopes-runtime'

export { buildDurableDaemonScopeCommand } from '../../../src/main/daemon/daemon-cgroup-scope'
export { wrapPtySpawnInTerminalScope } from '../../../src/main/daemon/terminal-scopes-runtime'
export { createLinuxCommandAutomationAdapter } from '../../../src/main/automations/automation-linux-command-adapter'
export { AutomationCommandService } from '../../../src/main/automations/automation-command-service'
export { createAutomationRunWriter } from '../../../src/main/automations/automation-run-writer'
export { Store } from '../../../src/main/persistence/loading-store/store'
export { ProfileStateSqliteAuthority } from '../../../src/main/persistence/profile-state/profile-state-sqlite-authority'
export {
  AutomationCommandDefinitionV1,
  readAutomationCommandsV1Domain
} from '../../../src/shared/automation-command-domain'
export { getDefaultPersistedState } from '../../../src/shared/constants'
export { recoverActiveAutomationCommandRuns } from '../../../src/main/persistence/loading-store/automation-command-run-recovery'
export {
  advanceAutomationCommandRun,
  settleAutomationCommandRun,
  releaseAutomationCommandClaim
} from '../../../src/main/persistence/scheduling-automations/automation-command-progress-operations'
export {
  bindAutomationCommandProcessIntent,
  recordAutomationCommandExitProof
} from '../../../src/main/persistence/scheduling-automations/automation-command-process-operations'

export function startScopeReaper(launchNonce: string, freshScope: boolean) {
  return startDaemonScopeDeathWatch({
    daemonScope: ownFreshDaemonScope(freshScope, launchNonce),
    log: () => {}
  })
}

/** What daemon-entry does at start: terminal scopes, then the death watch. */
export function startTerminalScopes(launchNonce: string) {
  const daemonScope = ownFreshDaemonScope(true, launchNonce)
  const events: unknown[] = []
  const ceiling = initializeTerminalScopes(daemonScope, (event, details) =>
    events.push({ event, ...details })
  )
  startDaemonScopeDeathWatch({ daemonScope, log: () => {} })
  return { ceiling, events }
}
