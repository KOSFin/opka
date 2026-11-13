import type { AutomationCommandDefinitionCreateV1 } from './automation-command-domain'
import type { AutomationOwnerPrecondition } from './automation-owner-precondition'
import { LOCAL_EXECUTION_HOST_ID } from './execution-host'
import { isWslUncPath } from './wsl-paths'

export function isLocalCommandAutomationOwner(
  definition: AutomationCommandDefinitionCreateV1
): boolean {
  const context = definition.runContext
  return (
    definition.executionTargetType === 'local' &&
    definition.executionTargetId === LOCAL_EXECUTION_HOST_ID &&
    definition.executionTargetGeneration === undefined &&
    definition.schedulerOwner === 'local_host_service' &&
    definition.workspaceMode === 'existing' &&
    context !== null &&
    context !== undefined &&
    context.hostId === LOCAL_EXECUTION_HOST_ID &&
    context.projectId === definition.projectId &&
    !isWslUncPath(context.path)
  )
}

export function assertCommandAutomationOwner(
  definition: AutomationCommandDefinitionCreateV1,
  expectedOwner?: AutomationOwnerPrecondition
): void {
  if (
    (expectedOwner && expectedOwner.selector.kind !== 'self') ||
    !isLocalCommandAutomationOwner(definition)
  ) {
    throw new Error(
      'Command automation execution host or project context changed or is unsupported.'
    )
  }
}
