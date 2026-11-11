import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  AutomationCommandDefinitionCreateV1,
  AutomationCommandManualReceiptV1,
  type AutomationCommandDefinitionV1,
  type AutomationCommandReportTargetOption
} from '../../../../shared/automation-command-domain'
import { AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY } from '../../../../shared/automation-runtime-capabilities'
import type { AutomationRun } from '../../../../shared/automations-types'
import {
  AutomationCancelRunV1,
  AutomationCreateV2,
  AutomationDeleteV2,
  AutomationRunNowV2,
  AutomationUpdateV2
} from '../../../../shared/rpc-contract/automation-command-params'
import type { AutomationHostTarget } from './automation-host-client'
import { AutomationHostScopeUnsupportedError } from './automation-capability-probe'
import { commandManualPayloadHash } from './automation-command-request-reconciliation'

const expectedOwner = { selector: { kind: 'self' as const } }
const options = { timeoutMs: 15_000 }

type CommandAdmission =
  | { kind: 'claimed' | 'replayed'; run: AutomationRun }
  | { kind: 'overlap'; activeRunId: string }

/** Probe the selected execution host immediately before each V2 read or effect. */
async function requireCommandHost(target: AutomationHostTarget): Promise<void> {
  const status = await callRuntimeRpc<{ capabilities?: string[] }>(
    target,
    'status.get',
    undefined,
    options
  )
  if (!status.capabilities?.includes(AUTOMATION_COMMAND_PIPELINE_RUNTIME_CAPABILITY)) {
    throw new AutomationHostScopeUnsupportedError(
      'This execution host cannot run command automations. Update or select a supported host.'
    )
  }
}

export async function listCommandAutomationsForTarget(
  target: AutomationHostTarget
): Promise<AutomationCommandDefinitionV1[]> {
  return (await listCommandAutomationsAndReportTargetsForTarget(target)).definitions
}

export async function listCommandAutomationsAndReportTargetsForTarget(
  target: AutomationHostTarget
): Promise<{
  definitions: AutomationCommandDefinitionV1[]
  reportTargets: AutomationCommandReportTargetOption[]
}> {
  await requireCommandHost(target)
  const result = await callRuntimeRpc<{
    commandAutomations?: AutomationCommandDefinitionV1[]
    commandReportTargets?: AutomationCommandReportTargetOption[]
  }>(target, 'automation.list', {}, options)
  return {
    definitions: result.commandAutomations ?? [],
    reportTargets: result.commandReportTargets ?? []
  }
}

export async function createCommandAutomationForTarget(
  target: AutomationHostTarget,
  definition: AutomationCommandDefinitionCreateV1,
  onPreflightAccepted?: () => void
): Promise<AutomationCommandDefinitionV1> {
  await requireCommandHost(target)
  const params = AutomationCreateV2.parse({
    version: 2,
    definition: AutomationCommandDefinitionCreateV1.parse(definition)
  })
  onPreflightAccepted?.()
  const result = await callRuntimeRpc<{ automation: AutomationCommandDefinitionV1 }>(
    target,
    'automation.createV2',
    params,
    options
  )
  return result.automation
}

export async function updateCommandAutomationForTarget(
  target: AutomationHostTarget,
  id: string,
  expectedRevision: number,
  updates: Partial<AutomationCommandDefinitionCreateV1>
): Promise<AutomationCommandDefinitionV1> {
  await requireCommandHost(target)
  const params = AutomationUpdateV2.parse({
    version: 2,
    id,
    expectedRevision,
    expectedOwner,
    updates
  })
  const result = await callRuntimeRpc<{ automation: AutomationCommandDefinitionV1 }>(
    target,
    'automation.updateV2',
    params,
    options
  )
  return result.automation
}

export async function deleteCommandAutomationForTarget(
  target: AutomationHostTarget,
  id: string,
  expectedRevision: number
): Promise<void> {
  await requireCommandHost(target)
  const params = AutomationDeleteV2.parse({ version: 2, id, expectedRevision, expectedOwner })
  await callRuntimeRpc(target, 'automation.deleteV2', params, options)
}

export async function runCommandAutomationForTarget(
  target: AutomationHostTarget,
  id: string,
  expectedRevision: number,
  requestKey: string,
  requestCreatedAt: number,
  onPreflightAccepted?: () => void
): Promise<{ admission: CommandAdmission }> {
  await requireCommandHost(target)
  const payloadHash = commandManualPayloadHash(id, expectedRevision)
  const params = AutomationRunNowV2.parse({
    version: 2,
    id,
    expectedRevision,
    expectedOwner,
    requestKey,
    requestCreatedAt,
    payloadHash
  })
  onPreflightAccepted?.()
  return callRuntimeRpc<{ admission: CommandAdmission }>(
    target,
    'automation.runNowV2',
    params,
    options
  )
}

export async function cancelCommandAutomationForTarget(
  target: AutomationHostTarget,
  id: string,
  runId: string,
  requestKey: string
): Promise<{ requested: true; observation: 'live' | 'unverifiable' | 'exited' }> {
  await requireCommandHost(target)
  const params = AutomationCancelRunV1.parse({
    version: 1,
    id,
    runId,
    expectedOwner,
    requestKey
  })
  return callRuntimeRpc<{ requested: true; observation: 'live' | 'unverifiable' | 'exited' }>(
    target,
    'automation.cancelRunV1',
    params,
    options
  )
}

export async function listCommandAutomationRunsForTarget(
  target: AutomationHostTarget,
  automationId: string
): Promise<AutomationRun[]> {
  await requireCommandHost(target)
  const result = await callRuntimeRpc<{ runs: AutomationRun[] }>(
    target,
    'automation.runs',
    { automationId },
    options
  )
  return result.runs
}

export async function reconcileCommandManualRequestForTarget(
  target: AutomationHostTarget,
  automationId: string,
  requestKey: string
): Promise<{ receipt: AutomationCommandManualReceiptV1 | null; runs: AutomationRun[] }> {
  await requireCommandHost(target)
  const result = await callRuntimeRpc<{ manualReceipt?: unknown; runs: AutomationRun[] }>(
    target,
    'automation.runs',
    { automationId, expectedOwner, manualRequestKey: requestKey },
    options
  )
  if (!Object.hasOwn(result, 'manualReceipt')) {
    throw new AutomationHostScopeUnsupportedError(
      'This host cannot reconcile the prior command request.'
    )
  }
  return {
    receipt:
      result.manualReceipt === null
        ? null
        : AutomationCommandManualReceiptV1.parse(result.manualReceipt),
    runs: result.runs
  }
}

export async function listCommandAutomationHistoryPageForTarget(
  target: AutomationHostTarget,
  cursor?: string
): Promise<{ runs: AutomationRun[]; nextCursor: string | null }> {
  await requireCommandHost(target)
  const result = await callRuntimeRpc<{ runs: AutomationRun[]; nextCursor: string | null }>(
    target,
    'automation.runs',
    { limit: 100, ...(cursor ? { cursor } : {}) },
    options
  )
  return {
    runs: result.runs.filter((run) => run.sessionKind === 'command'),
    nextCursor: result.nextCursor
  }
}
