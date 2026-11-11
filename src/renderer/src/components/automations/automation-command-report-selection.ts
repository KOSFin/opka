import type { PendingRequests } from './automation-command-pending-requests'

export type RequestedCommandReport = { automationId: string; runId: string }
type DefinitionLookup = { id: string; creationKey?: string }
type RunLookup = { id: string }

export function commandHostErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The execution host did not answer.'
}

export function selectCommandDefinitionId(
  definitions: readonly DefinitionLookup[],
  currentId: string | null,
  requested: RequestedCommandReport | null | undefined
): string | null {
  if (requested) {
    return definitions.some((entry) => entry.id === requested.automationId)
      ? requested.automationId
      : null
  }
  return definitions.some((entry) => entry.id === currentId)
    ? currentId
    : (definitions[0]?.id ?? null)
}

export function selectCommandReportRunId(
  runs: readonly RunLookup[],
  currentId: string | null,
  requestedRunId: string | null
): string | null {
  if (requestedRunId) {
    return runs.some((run) => run.id === requestedRunId) ? requestedRunId : null
  }
  return runs.some((run) => run.id === currentId) ? currentId : (runs[0]?.id ?? null)
}

export function visibleCommandReportRun<T extends RunLookup>(
  runs: readonly T[],
  selectedRunId: string | null,
  selectedAutomationId: string | null,
  requested: RequestedCommandReport | null | undefined
): T | null {
  if (requested?.automationId === selectedAutomationId) {
    return selectedRunId === requested.runId
      ? (runs.find((run) => run.id === requested.runId) ?? null)
      : null
  }
  const selected = runs.find((run) => run.id === selectedRunId)
  if (selected) {
    return selected
  }
  return runs[0] ?? null
}

export function missingCommandDefinitionReport(
  definitions: readonly DefinitionLookup[],
  requested: RequestedCommandReport | null | undefined
): string | null {
  return requested && !definitions.some((entry) => entry.id === requested.automationId)
    ? 'The linked automation report is unavailable on this host.'
    : null
}

export function missingCommandRunReport(
  runs: readonly RunLookup[],
  requestedRunId: string | null
): string | null {
  return requestedRunId && !runs.some((run) => run.id === requestedRunId)
    ? 'The linked report is unavailable on this host.'
    : null
}

export function settleVisibleCommandCreate(
  pending: PendingRequests,
  definitions: readonly DefinitionLookup[]
): void {
  if (
    pending.create &&
    definitions.some((entry) => entry.creationKey === pending.create?.input.creationKey)
  ) {
    pending.create = null
  }
}
