import type {
  AutomationCommandClaimV1,
  AutomationCommandDefinitionV1
} from '../../shared/automation-command-domain'
import {
  decideAutomationCommandCondition,
  type AutomationCommandObservation
} from '../../shared/automation-command-execution'
import type { AutomationRun } from '../../shared/automations-types'
import { clampUtf8TextPrefix } from '../../shared/utf8-byte-limits'
import type { CommandProgressFence } from '../persistence/scheduling-automations/automation-command-progress-operations'
import type { AutomationRunWriter } from './automation-run-writer'

type CommandExit =
  | { verdict: 'exited'; observation: AutomationCommandObservation }
  | { verdict: 'unverifiable' }

type AgentExit = { verdict: 'exited'; success: boolean } | { verdict: 'unverifiable' }

export type AutomationCommandRunAdapter = {
  readReportRun?(claim: AutomationCommandClaimV1): AutomationRun | null
  executeCommand(
    definition: AutomationCommandDefinitionV1,
    claim: AutomationCommandClaimV1
  ): Promise<CommandExit>
  runOneShotAgent?(
    agent: NonNullable<AutomationCommandDefinitionV1['execution']['agent']>,
    definition: AutomationCommandDefinitionV1,
    claim: AutomationCommandClaimV1
  ): Promise<AgentExit>
  deliverReport(
    target: NonNullable<AutomationCommandDefinitionV1['execution']['reportTarget']>,
    run: AutomationRun
  ): Promise<boolean | 'unverifiable'>
  isCancelRequested?(claim: AutomationCommandClaimV1): boolean
  now(): number
}

export type AutomationCommandRunOutcome =
  | { kind: 'settled'; run: AutomationRun }
  | { kind: 'unverifiable'; run: AutomationRun }

/** Continue only the already-durable claim; adapters must prove exit before the next effect. */
export async function runClaimedAutomationCommand(input: {
  definition: AutomationCommandDefinitionV1
  claim: AutomationCommandClaimV1
  runs: Pick<AutomationRunWriter, 'advanceCommandRun' | 'settleCommandRun'>
  adapter: AutomationCommandRunAdapter
}): Promise<AutomationCommandRunOutcome> {
  const { definition, claim, runs, adapter } = input
  const fence: CommandProgressFence = {
    automationId: claim.automationId,
    runId: claim.runId,
    acquisitionId: claim.acquisitionId,
    hostGeneration: claim.hostGeneration,
    expectedPhase: claim.phase
  }
  if (claim.phase === 'report') {
    const retained = adapter.readReportRun?.(claim)
    if (
      !retained ||
      retained.id !== claim.runId ||
      retained.automationId !== claim.automationId ||
      retained.commandExecution?.phase !== 'report' ||
      !retained.commandExecution.pendingStatus ||
      !retained.outputSnapshot ||
      retained.commandExecution.finalReason === null
    ) {
      throw new Error('Retained report cannot be verified without its durable row.')
    }
    return deliverAndSettleReport({
      definition,
      report: retained,
      fence,
      runs,
      adapter,
      status: retained.commandExecution.pendingStatus,
      reason: retained.commandExecution.finalReason
    })
  }
  if (claim.phase === 'condition' && !claim.processIntent?.exitProof) {
    throw new Error('Command stage cannot be resumed without a replay-safe proof.')
  }
  if (claim.phase === 'acquiring') {
    await runs.advanceCommandRun(fence, { phase: 'command', observation: 'live' })
    fence.expectedPhase = 'command'
  } else if (!['command', 'condition', 'report'].includes(claim.phase)) {
    throw new Error('Command claim cannot resume after a later effect stage.')
  }

  let command: CommandExit
  if (claim.phase === 'condition') {
    const proof = claim.processIntent?.exitProof
    if (!proof) {
      throw new Error('Command exit proof disappeared.')
    }
    const { verifiedAt: _verifiedAt, ...observation } = proof
    command = { verdict: 'exited', observation }
  } else {
    try {
      command = await adapter.executeCommand(definition, claim)
    } catch {
      command = { verdict: 'unverifiable' }
    }
  }
  if (command.verdict === 'unverifiable') {
    return {
      kind: 'unverifiable',
      run: await runs.advanceCommandRun(fence, {
        phase: 'unverifiable',
        observation: 'unverifiable'
      })
    }
  }

  if (fence.expectedPhase === 'command') {
    await runs.advanceCommandRun(fence, { phase: 'condition', observation: 'exited' })
    fence.expectedPhase = 'condition'
  }
  const decision = decideAutomationCommandCondition(
    definition.execution.condition,
    command.observation
  )
  let status: 'completed' | 'skipped_precheck' | 'dispatch_failed' =
    decision.outcome === 'failed'
      ? 'dispatch_failed'
      : decision.outcome === 'skipped'
        ? 'skipped_precheck'
        : 'completed'
  let reason: string = decision.reason

  if (adapter.isCancelRequested?.(claim)) {
    status = 'dispatch_failed'
    reason = 'cancel_requested'
  }

  if (status === 'completed' && decision.outcome === 'proceed' && definition.execution.agent) {
    await runs.advanceCommandRun(fence, { phase: 'agent', observation: 'exited' })
    fence.expectedPhase = 'agent'
    if (!adapter.runOneShotAgent) {
      status = 'dispatch_failed'
      reason = 'agent_adapter_unavailable'
    } else {
      let agent: AgentExit
      try {
        agent = await adapter.runOneShotAgent(definition.execution.agent, definition, claim)
      } catch {
        agent = { verdict: 'unverifiable' }
      }
      if (agent.verdict === 'unverifiable') {
        return {
          kind: 'unverifiable',
          run: await runs.advanceCommandRun(fence, {
            phase: 'unverifiable',
            observation: 'unverifiable'
          })
        }
      }
      if (!agent.success) {
        status = 'dispatch_failed'
        reason = 'agent_failed'
      }
    }
  }

  const reportText = [
    `${definition.name}: ${status} (${reason}). Run ${claim.runId}.`,
    `Command exit: ${command.observation.exitCode ?? 'unknown'}.`,
    command.observation.stdout ? `stdout:\n${command.observation.stdout}` : '',
    command.observation.stderr ? `stderr:\n${command.observation.stderr}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  const reportContent = clampUtf8TextPrefix(reportText, 16 * 1024)
  const outputSnapshot = {
    format: 'plain_text' as const,
    content: reportContent,
    capturedAt: adapter.now(),
    truncated:
      reportContent.length !== reportText.length ||
      command.observation.stdoutTruncated ||
      command.observation.stderrTruncated === true
  }
  const report = await runs.advanceCommandRun(fence, {
    phase: 'report',
    observation: 'exited',
    finalReason: reason,
    pendingStatus: status,
    outputSnapshot
  })
  fence.expectedPhase = 'report'
  return deliverAndSettleReport({ definition, report, fence, runs, adapter, status, reason })
}

async function deliverAndSettleReport(input: {
  definition: AutomationCommandDefinitionV1
  report: AutomationRun
  fence: CommandProgressFence
  runs: Pick<AutomationRunWriter, 'settleCommandRun'>
  adapter: AutomationCommandRunAdapter
  status: 'completed' | 'skipped_precheck' | 'dispatch_failed'
  reason: string
}): Promise<AutomationCommandRunOutcome> {
  const { definition, report, fence, runs, adapter, status, reason } = input
  let deliveryStatus: 'history_only' | 'delivered' | 'failed' = 'history_only'
  if (definition.execution.reportTarget) {
    try {
      const delivered = await adapter.deliverReport(definition.execution.reportTarget, report)
      if (delivered === 'unverifiable') {
        return { kind: 'unverifiable', run: report }
      }
      deliveryStatus = delivered ? 'delivered' : 'failed'
    } catch {
      return { kind: 'unverifiable', run: report }
    }
  }
  return {
    kind: 'settled',
    run: await runs.settleCommandRun(fence, {
      status,
      finalReason: reason,
      outputSnapshot: report.outputSnapshot,
      deliveryStatus
    })
  }
}
