import { stat } from 'node:fs/promises'
import type { Store } from '../persistence'
import type {
  AutomationCommandClaimV1,
  AutomationCommandDefinitionV1
} from '../../shared/automation-command-domain'
import { parseExtraAgentArgs } from '../../shared/automation-extra-agent-args'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { readCodexCliInstallation } from '../preflight/codex-cli-installation'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import type { AutomationRunWriter } from './automation-run-writer'
import { executeLinuxCgroupAutomationAgent } from './automation-linux-cgroup-command'

type AgentInputs = {
  store: Pick<Store, 'getCommandAutomationClaim'>
  hostGeneration: number
  isCurrentOwner(): boolean
  runs: Pick<AutomationRunWriter, 'bindAgentProcessIntent' | 'recordAgentExitProof'>
  resolveExistingWorkspaceCwd(definition: AutomationCommandDefinitionV1): Promise<string | null>
}

function fingerprint(stats: Awaited<ReturnType<typeof stat>>): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs, stats.mode].join(':')
}

async function binaryAt(cwd: string): Promise<{ path: string; fingerprint: string } | null> {
  const path = await resolveCommandOnLocalPath('codex', { env: process.env, cwd })
  if (!path) {
    return null
  }
  try {
    const before = await stat(path)
    const version = await readCodexCliInstallation({ program: path, cwd, env: process.env })
    const after = await stat(path)
    return version.status === 'ready' &&
      after.isFile() &&
      fingerprint(before) === fingerprint(after)
      ? { path, fingerprint: fingerprint(after) }
      : null
  } catch {
    return null
  }
}

function agentArgs(definition: AutomationCommandDefinitionV1): string[] | null {
  const agent = definition.execution.agent
  if (!agent || agent.agentId !== 'codex' || agent.sessionPolicy !== 'ephemeral') {
    return null
  }
  const extras = agent.extraAgentArgs
    ? parseExtraAgentArgs({ agent: 'codex', extraAgentArgs: agent.extraAgentArgs })
    : null
  if (extras && !extras.ok) {
    return null
  }
  return [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    ...(extras?.tokens ?? [])
  ]
}

export function createLinuxOneShotAutomationAgent(inputs: AgentInputs) {
  return {
    supportsDefinition: async (definition: AutomationCommandDefinitionV1): Promise<boolean> => {
      if (
        !inputs.isCurrentOwner() ||
        definition.executionTargetType !== 'local' ||
        definition.executionTargetId !== LOCAL_EXECUTION_HOST_ID ||
        definition.execution.policy.maxAttempts !== 1 ||
        !agentArgs(definition)
      ) {
        return false
      }
      const cwd = await inputs.resolveExistingWorkspaceCwd(definition)
      return cwd !== null && (await binaryAt(cwd)) !== null
    },
    run: async (
      agent: NonNullable<AutomationCommandDefinitionV1['execution']['agent']>,
      definition: AutomationCommandDefinitionV1,
      claim: AutomationCommandClaimV1
    ): Promise<{ verdict: 'exited'; success: boolean } | { verdict: 'unverifiable' }> => {
      const current = inputs.store.getCommandAutomationClaim(claim.automationId, claim.runId)
      const args = agentArgs(definition)
      const selectedAgent = definition.execution.agent
      if (
        !current ||
        !selectedAgent ||
        current.acquisitionId !== claim.acquisitionId ||
        current.hostGeneration !== claim.hostGeneration ||
        claim.hostGeneration !== inputs.hostGeneration ||
        !inputs.isCurrentOwner() ||
        current.definitionRevision !== definition.revision ||
        current.phase !== 'agent' ||
        current.cancelRequestedAt !== undefined ||
        !current.agentIntent ||
        agent.agentId !== selectedAgent.agentId ||
        agent.prompt !== selectedAgent.prompt ||
        !args
      ) {
        return { verdict: 'unverifiable' }
      }
      const cwd = await inputs.resolveExistingWorkspaceCwd(definition)
      if (!cwd) {
        return { verdict: 'unverifiable' }
      }
      const binary = await binaryAt(cwd)
      if (!binary) {
        return { verdict: 'unverifiable' }
      }
      const remainingSeconds = Math.floor(
        (claim.createdAt + definition.execution.policy.timeoutSeconds * 1000 - Date.now()) / 1000
      )
      if (remainingSeconds < 1) {
        return { verdict: 'unverifiable' }
      }
      const fence = {
        automationId: claim.automationId,
        runId: claim.runId,
        acquisitionId: claim.acquisitionId,
        hostGeneration: claim.hostGeneration,
        expectedPhase: 'agent' as const
      }
      const outcome = await executeLinuxCgroupAutomationAgent({
        claim: current,
        cwd,
        executable: binary.path,
        binaryFingerprint: binary.fingerprint,
        args,
        prompt: agent.prompt,
        timeoutSeconds: remainingSeconds,
        bindReceipt: async (receipt) => {
          await inputs.runs.bindAgentProcessIntent(fence, {
            ...receipt,
            binaryPath: binary.path,
            binaryFingerprint: binary.fingerprint
          })
        },
        persistExitProof: async (observation) => {
          await inputs.runs.recordAgentExitProof(fence, observation, Date.now())
        },
        mayReleaseGate: async () => {
          const latest = inputs.store.getCommandAutomationClaim(claim.automationId, claim.runId)
          const latestCwd = await inputs.resolveExistingWorkspaceCwd(definition)
          if (
            !latest ||
            latest.acquisitionId !== claim.acquisitionId ||
            latest.hostGeneration !== claim.hostGeneration ||
            claim.hostGeneration !== inputs.hostGeneration ||
            !inputs.isCurrentOwner() ||
            latest.definitionRevision !== definition.revision ||
            latest.phase !== 'agent' ||
            latest.cancelRequestedAt !== undefined ||
            latest.agentIntent?.execMayHappen !== true ||
            latest.agentIntent.binaryPath !== binary.path ||
            latest.agentIntent.binaryFingerprint !== binary.fingerprint ||
            latestCwd !== cwd ||
            Date.now() >= claim.createdAt + definition.execution.policy.timeoutSeconds * 1000
          ) {
            return false
          }
          try {
            return fingerprint(await stat(binary.path)) === binary.fingerprint
          } catch {
            return false
          }
        }
      })
      if (outcome.verdict === 'unverifiable') {
        return outcome
      }
      return {
        verdict: 'exited',
        success:
          outcome.observation.exitCode === 0 &&
          !outcome.observation.timedOut &&
          outcome.observation.error === null
      }
    }
  }
}
