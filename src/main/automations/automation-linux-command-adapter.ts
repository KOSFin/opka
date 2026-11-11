import type { Store } from '../persistence'
import { existsSync } from 'node:fs'
import type { AutomationCommandDefinitionV1 } from '../../shared/automation-command-domain'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AutomationCommandHostAdapter } from './automation-command-service'
import type { AutomationRunWriter } from './automation-run-writer'
import {
  cancelLinuxCgroupAutomationCommand,
  executeLinuxCgroupAutomationCommand
} from './automation-linux-cgroup-command'
import { isDurableDaemonScopeSupported } from '../daemon/daemon-cgroup-scope'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'

type CommandAdapterInputs = {
  store: Pick<Store, 'getCommandAutomationClaim'>
  runs: Pick<AutomationRunWriter, 'bindCommandProcessIntent' | 'recordCommandExitProof'>
  resolveExistingWorkspaceCwd(definition: AutomationCommandDefinitionV1): Promise<string | null>
}

/** Command-only capability seam; registration requires a separately proven host probe. */
export function createLinuxCommandAutomationAdapter(
  inputs: CommandAdapterInputs
): AutomationCommandHostAdapter {
  const scopeReady = process.platform === 'linux' && isDurableDaemonScopeSupported()
  const resolveCommand = async (definition: AutomationCommandDefinitionV1, cwd: string) => {
    const command = definition.execution.command
    const executable =
      command.kind === 'program'
        ? command.executable
        : (command.interpreter ?? (command.language === 'shell' ? '/bin/sh' : 'python3'))
    return resolveCommandOnLocalPath(executable, { env: process.env, cwd })
  }
  return {
    isHostReady: () => scopeReady,
    supportsDefinition: async (definition) => {
      if (
        !scopeReady ||
        definition.executionTargetType !== 'local' ||
        definition.executionTargetId !== LOCAL_EXECUTION_HOST_ID ||
        definition.workspaceMode !== 'existing' ||
        definition.execution.agent !== null ||
        definition.execution.reportTarget !== null ||
        definition.execution.policy.maxAttempts !== 1
      ) {
        return false
      }
      const cwd = await inputs.resolveExistingWorkspaceCwd(definition)
      return cwd !== null && (await resolveCommand(definition, cwd)) !== null
    },
    executeCommand: async (definition, claim) => {
      const existing =
        claim.processIntent?.receiptDirectory &&
        (claim.processIntent.exitProof || existsSync(claim.processIntent.receiptDirectory))
      const cwd = existing
        ? (definition.runContext?.path ?? process.cwd())
        : await inputs.resolveExistingWorkspaceCwd(definition)
      if (!cwd) {
        return { verdict: 'unverifiable' }
      }
      const resolvedExecutable = existing ? '' : await resolveCommand(definition, cwd)
      if (resolvedExecutable === null) {
        return { verdict: 'unverifiable' }
      }
      return executeLinuxCgroupAutomationCommand({
        definition,
        claim,
        cwd,
        resolvedExecutable,
        bindReceipt: async (receipt) => {
          await inputs.runs.bindCommandProcessIntent(
            {
              automationId: claim.automationId,
              runId: claim.runId,
              acquisitionId: claim.acquisitionId,
              hostGeneration: claim.hostGeneration,
              expectedPhase: 'command'
            },
            receipt
          )
        },
        persistExitProof: async (observation) => {
          await inputs.runs.recordCommandExitProof(
            {
              automationId: claim.automationId,
              runId: claim.runId,
              acquisitionId: claim.acquisitionId,
              hostGeneration: claim.hostGeneration,
              expectedPhase: 'command'
            },
            observation,
            Date.now()
          )
        },
        mayReleaseGate: () => {
          const current = inputs.store.getCommandAutomationClaim(claim.automationId, claim.runId)
          return (
            current?.acquisitionId === claim.acquisitionId &&
            current.hostGeneration === claim.hostGeneration &&
            current.phase === 'command' &&
            current.processIntent?.execMayHappen === true &&
            current.cancelRequestedAt === undefined
          )
        }
      })
    },
    cancelRun: async (claim) => cancelLinuxCgroupAutomationCommand(claim),
    isCancelRequested: (claim) => {
      const current = inputs.store.getCommandAutomationClaim(claim.automationId, claim.runId)
      return (
        !current ||
        current.acquisitionId !== claim.acquisitionId ||
        current.cancelRequestedAt !== undefined
      )
    },
    deliverReport: async () => false,
    now: Date.now
  }
}
