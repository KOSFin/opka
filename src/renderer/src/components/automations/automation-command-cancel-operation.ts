import { createUuidV4 } from '../../../../shared/uuid-v4'
import type { AutomationHostTarget } from './automation-host-client'
import { cancelCommandAutomationForTarget } from './automation-command-host-client'
import type { PendingCommandCancel, PendingRequests } from './automation-command-pending-requests'

export async function requestCommandRunCancel(
  target: AutomationHostTarget,
  automationId: string,
  runId: string,
  pending: PendingRequests
): Promise<{
  request: PendingCommandCancel
  observation: 'live' | 'unverifiable' | 'exited'
}> {
  const request = pending.cancels.get(runId) ?? {
    automationId,
    runId,
    key: createUuidV4()
  }
  pending.cancels.set(runId, request)
  const result = await cancelCommandAutomationForTarget(
    target,
    request.automationId,
    request.runId,
    request.key
  )
  return { request, observation: result.observation }
}
