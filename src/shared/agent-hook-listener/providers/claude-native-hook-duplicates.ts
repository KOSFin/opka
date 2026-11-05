import type { ClaudeLeadTurnState, HookListenerState } from '../listener-state'
import { buildClaudeStatusPayload } from './claude-status-build'

/** The public hook observer must not reset an earlier private engine-origin startup. */
export function readClaudeNativeStartDuplicate(
  state: HookListenerState,
  key: string,
  promptText: string,
  payload: Record<string, unknown>
) {
  const lead = state.claudeLeadStateByPaneKey.get(key)
  if (
    !lead?.nativeCoverage ||
    !lead.nativeStart ||
    lead.nativeStart?.sessionId !== payload.session_id ||
    lead.nativeStart.source !== payload.source
  ) {
    return null
  }
  return buildClaudeStatusPayload(state, 'SessionStart', promptText, key, payload, {
    stateName: lead.state,
    updateToolSnapshot: false,
    sessionBoundary: lead.nativeCoverage.currentMainTurnId === undefined
  })
}

export function readClaudeNativeFailureReceipt(
  payload: Record<string, unknown>,
  promptId: string | undefined,
  previous: ClaudeLeadTurnState | undefined
): ClaudeLeadTurnState['nativeFailure'] {
  if (payload.error !== 'rate_limit' || typeof payload.session_id !== 'string' || !promptId) {
    return undefined
  }
  return previous?.nativeFailure?.sessionId === payload.session_id &&
    previous.nativeFailure.promptId === promptId &&
    previous.nativeFailure.turnId === previous.nativeCoverage?.currentMainTurnId
    ? previous.nativeFailure
    : {
        sessionId: payload.session_id,
        promptId,
        observedAt: Date.now(),
        turnId: previous?.nativeCoverage?.currentMainTurnId
      }
}
