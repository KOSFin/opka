import { basename } from 'node:path'
import type { CodexSubagentTranscriptState } from './codex-subagent-transcript'
import type { CodexSubagentRoster } from './codex-subagent-roster'
import { verifyJsonlCursorHistory, record, type JsonRecord } from './codex-rollout-jsonl-cursor'

export type NativeCodexChildInventory =
  | { status: 'settled' }
  | { status: 'live' }
  | { status: 'unverifiable'; reason: string }

/** Missing or display-retired children never certify that a native turn has settled. */
export function readCodexNativeChildInventory(
  transcript: CodexSubagentTranscriptState | undefined,
  roster: CodexSubagentRoster | undefined,
  sessionId: string
): NativeCodexChildInventory {
  if (!transcript || !roster || !transcript.parent.filePath) {
    return { status: 'unverifiable', reason: 'source-unavailable' }
  }
  if (
    transcript.providerSessionId !== sessionId ||
    !/^[A-Za-z0-9-]{1,64}$/.test(sessionId) ||
    !basename(transcript.parent.filePath).endsWith(`-${sessionId}.jsonl`)
  ) {
    return { status: 'unverifiable', reason: 'session-mismatch' }
  }
  if (transcript.toolSettlementUnverifiable) {
    return { status: 'unverifiable', reason: 'tool-settlement-unverified' }
  }
  if (transcript.childSettlementUnverifiable) {
    return { status: 'unverifiable', reason: 'child-settlement-unverifiable' }
  }
  if (transcript.pendingNativeTools?.size) {
    return { status: 'live' }
  }
  if (!verifyJsonlCursorHistory(transcript.parent)) {
    return { status: 'unverifiable', reason: 'history-incomplete' }
  }
  for (const child of transcript.subagents.values()) {
    if (!verifyJsonlCursorHistory(child)) {
      return { status: 'unverifiable', reason: 'child-history-incomplete' }
    }
  }
  return { status: transcript.subagents.size || roster.size ? 'live' : 'settled' }
}

function validSubagentActivity(payload: JsonRecord | undefined): boolean {
  return (
    typeof payload?.agent_thread_id === 'string' &&
    /^[A-Za-z0-9-]{1,64}$/.test(payload.agent_thread_id.trim()) &&
    typeof payload.kind === 'string' &&
    ['started', 'interacted', 'interrupted'].includes(payload.kind.toLowerCase())
  )
}

export function observeCodexNativeInventoryRecords(
  state: CodexSubagentTranscriptState,
  records: readonly JsonRecord[]
): void {
  for (const item of records) {
    if (item.type === 'response_item') {
      observeNativeToolInvocation(state, record(item.payload))
    }
    if (item.type === 'session_meta') {
      const id = record(item.payload)?.id
      if (
        typeof id !== 'string' ||
        !/^[A-Za-z0-9-]{1,64}$/.test(id) ||
        (state.providerSessionId !== undefined && state.providerSessionId !== id)
      ) {
        if (state.parent.verification) {
          state.parent.verification.intact = false
        }
      } else {
        state.providerSessionId = id
      }
    }
    if (
      item.type === 'event_msg' &&
      record(item.payload)?.type === 'sub_agent_activity' &&
      !validSubagentActivity(record(item.payload))
    ) {
      if (state.parent.verification) {
        state.parent.verification.intact = false
      }
    }
  }
}

function observeNativeToolInvocation(
  state: CodexSubagentTranscriptState,
  payload: JsonRecord | undefined
): void {
  const type = payload?.type
  if (
    type !== 'function_call' &&
    type !== 'custom_tool_call' &&
    type !== 'function_call_output' &&
    type !== 'custom_tool_call_output'
  ) {
    return
  }
  const id = payload?.call_id
  if (typeof id !== 'string' || id.length === 0 || id.length > 200 || id.trim() !== id) {
    state.toolSettlementUnverifiable = true
    return
  }
  if (
    (type === 'function_call_output' || type === 'custom_tool_call_output') &&
    typeof payload?.output !== 'string' &&
    !Array.isArray(payload?.output)
  ) {
    state.toolSettlementUnverifiable = true
    return
  }
  state.pendingNativeTools ??= new Map()
  if (type === 'function_call' || type === 'custom_tool_call') {
    if (state.pendingNativeTools.size >= 256 || state.pendingNativeTools.has(id)) {
      state.toolSettlementUnverifiable = true
      return
    }
    state.pendingNativeTools.set(id, type)
  } else if (`${state.pendingNativeTools.get(id)}_output` === type) {
    state.pendingNativeTools.delete(id)
  } else {
    state.toolSettlementUnverifiable = true
  }
}
