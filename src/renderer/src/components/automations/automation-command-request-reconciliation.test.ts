import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { AutomationCommandManualReceiptV1 } from '../../../../shared/automation-command-domain'
import {
  pendingCommandRequests,
  type PendingCommandRun
} from './automation-command-pending-requests'
import {
  COMMAND_MANUAL_REPLAY_WINDOW_MS,
  commandManualPayloadHash,
  reconcilePendingCommandRun
} from './automation-command-request-reconciliation'

const started = Date.UTC(2026, 10, 11, 7)
const request: PendingCommandRun = {
  id: 'automation-1',
  revision: 2,
  key: 'same-key',
  createdAt: started
}

function run(createdAt: number): AutomationRun {
  return {
    id: 'run-1',
    automationId: request.id,
    title: 'One command',
    scheduledFor: createdAt,
    status: 'completed',
    trigger: 'manual',
    workspaceId: null,
    sessionKind: 'command',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: createdAt,
    dispatchedAt: createdAt,
    createdAt
  }
}

afterEach(() => vi.useRealTimers())

describe('manual command request recovery', () => {
  it('keeps a lost answer across mode remount and resolves the old effect after 24 hours', () => {
    vi.useFakeTimers()
    vi.setSystemTime(started)
    const pending = pendingCommandRequests('fixture:lost-answer')
    pending.runs.set(request.id, request)
    const reopened = pendingCommandRequests('fixture:lost-answer')
    expect(reopened.runs.get(request.id)).toBe(request)
    vi.setSystemTime(started + COMMAND_MANUAL_REPLAY_WINDOW_MS + 1)
    const receipt: AutomationCommandManualReceiptV1 = {
      automationId: request.id,
      requestKey: request.key,
      payloadHash: commandManualPayloadHash(request.id, request.revision),
      createdAt: started,
      runId: 'run-1'
    }
    const result = reconcilePendingCommandRun(request, receipt, [run(started + 1)], Date.now(), 2)
    expect(result).toEqual({ kind: 'admitted', runId: 'run-1', overlap: false })
    expect(result.kind).not.toBe('safe_no_effect')
  })

  it('does not accept a receipt with a mismatched payload, timestamp, or visible run owner', () => {
    const receipt: AutomationCommandManualReceiptV1 = {
      automationId: request.id,
      requestKey: request.key,
      payloadHash: commandManualPayloadHash(request.id, request.revision),
      createdAt: request.createdAt,
      runId: 'run-1'
    }
    const now = started + COMMAND_MANUAL_REPLAY_WINDOW_MS + 1
    const history = [run(started + 1)]
    expect(
      reconcilePendingCommandRun(
        request,
        { ...receipt, payloadHash: 'a'.repeat(64) },
        history,
        now,
        2
      )
    ).toEqual({ kind: 'unverifiable' })
    expect(
      reconcilePendingCommandRun(request, { ...receipt, createdAt: started + 1 }, history, now, 2)
    ).toEqual({ kind: 'unverifiable' })
    expect(
      reconcilePendingCommandRun(
        request,
        receipt,
        [{ ...history[0], automationId: 'other-automation' }],
        now,
        2
      )
    ).toEqual({ kind: 'unverifiable' })
  })

  it('requires the expired key and complete retained history before a new request', () => {
    vi.useFakeTimers()
    vi.setSystemTime(started + COMMAND_MANUAL_REPLAY_WINDOW_MS + 1)
    expect(reconcilePendingCommandRun(request, null, [], Date.now(), 2)).toEqual({
      kind: 'safe_no_effect'
    })
    expect(reconcilePendingCommandRun(request, null, [run(started + 1)], Date.now(), 2)).toEqual({
      kind: 'unverifiable'
    })
    expect(
      reconcilePendingCommandRun(
        request,
        null,
        Array.from({ length: 100 }, (_, index) => run(started - index)),
        Date.now(),
        2
      )
    ).toEqual({ kind: 'unverifiable' })
  })

  it('refuses a new request inside the replay window unless a newer revision closes admission', () => {
    vi.useFakeTimers()
    vi.setSystemTime(started + 1000)
    expect(reconcilePendingCommandRun(request, null, [], Date.now(), 2)).toEqual({
      kind: 'unverifiable'
    })
    expect(reconcilePendingCommandRun(request, null, [], Date.now(), 3)).toEqual({
      kind: 'safe_no_effect'
    })
  })
})
