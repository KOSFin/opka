import { createUuidV4 } from '../../../../shared/uuid-v4'
import type { AutomationCommandDefinitionV1 } from '../../../../shared/automation-command-domain'
import type { AutomationHostTarget } from './automation-host-client'
import { runCommandAutomationForTarget } from './automation-command-host-client'
import {
  commandRequestNow,
  type PendingCommandRun,
  type PendingRequests
} from './automation-command-pending-requests'
import { COMMAND_MANUAL_REPLAY_WINDOW_MS } from './automation-command-request-reconciliation'

export async function admitCommandManualRun(
  target: AutomationHostTarget,
  definition: AutomationCommandDefinitionV1,
  pending: PendingRequests
): Promise<{
  admission: Awaited<ReturnType<typeof runCommandAutomationForTarget>>['admission']
  request: PendingCommandRun
}> {
  const prior = pending.runs.get(definition.id)
  if (
    prior &&
    (prior.revision !== definition.revision ||
      commandRequestNow() - prior.createdAt > COMMAND_MANUAL_REPLAY_WINDOW_MS)
  ) {
    throw new Error('The prior request changed or expired. Reconcile it before another run.')
  }
  const request = prior ?? {
    id: definition.id,
    revision: definition.revision,
    key: createUuidV4(),
    createdAt: commandRequestNow()
  }
  const result = await runCommandAutomationForTarget(
    target,
    request.id,
    request.revision,
    request.key,
    request.createdAt,
    prior
      ? undefined
      : () => {
          pending.runs.set(request.id, request)
        }
  )
  return { admission: result.admission, request }
}
