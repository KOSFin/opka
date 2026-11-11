import type { AutomationCommandManualReceiptV1 } from '../../../../shared/automation-command-domain'
import type { AutomationRun } from '../../../../shared/automations-types'
import { MAX_AUTOMATION_RUNS_PER_AUTOMATION } from '../../../../shared/automation-run-retention'
import { sha256 } from '../../../../shared/sha256'
import type { PendingCommandRun } from './automation-command-pending-requests'

export const COMMAND_MANUAL_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000

export function commandManualPayloadHash(id: string, revision: number): string {
  return Array.from(
    sha256(new TextEncoder().encode(JSON.stringify({ id, expectedRevision: revision }))),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('')
}

export type CommandRequestReconciliation =
  | { kind: 'admitted'; runId: string; overlap: boolean }
  | { kind: 'safe_no_effect' }
  | { kind: 'unverifiable' }

export function reconcilePendingCommandRun(
  request: PendingCommandRun,
  receipt: AutomationCommandManualReceiptV1 | null,
  runs: readonly AutomationRun[],
  now: number,
  currentRevision: number
): CommandRequestReconciliation {
  if (receipt) {
    const matchingRun = runs.find((run) => run.id === receipt.runId)
    if (
      receipt.automationId !== request.id ||
      receipt.requestKey !== request.key ||
      receipt.payloadHash !== commandManualPayloadHash(request.id, request.revision) ||
      receipt.createdAt !== request.createdAt ||
      (matchingRun && matchingRun.automationId !== request.id)
    ) {
      return { kind: 'unverifiable' }
    }
    return { kind: 'admitted', runId: receipt.runId, overlap: receipt.outcome === 'overlap' }
  }
  if (
    !Number.isSafeInteger(now) ||
    (now - request.createdAt <= COMMAND_MANUAL_REPLAY_WINDOW_MS &&
      currentRevision === request.revision) ||
    runs.length >= MAX_AUTOMATION_RUNS_PER_AUTOMATION ||
    runs.some((run) => run.automationId !== request.id || run.createdAt >= request.createdAt)
  ) {
    return { kind: 'unverifiable' }
  }
  return { kind: 'safe_no_effect' }
}
