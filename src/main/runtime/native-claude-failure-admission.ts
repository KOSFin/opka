import type {
  NativeClaudeHookReply,
  NativeClaudeHookRequest
} from '../../shared/native-claude-hook'
export type NativeClaudeQuotaFailureConfirmation = (
  failure: { accountId: string; sessionId: string; promptId: string },
  canConfirm: () => boolean,
  signal?: AbortSignal
) => Promise<boolean>

/** Exhaustion confirmation and the canonical failed boundary must both survive asynchronous work. */
export function createNativeClaudeFailureAdmission(options: {
  confirm?: NativeClaudeQuotaFailureConfirmation
  readBoundary: () => { canSwitch: () => boolean }
  readAccountId: () => string
  prepare: (promptId: string, accountId: string) => Promise<string | null>
  onRefused: () => void
}) {
  return async (
    request: Extract<NativeClaudeHookRequest, { event: 'failure' }>,
    signal?: AbortSignal
  ): Promise<NativeClaudeHookReply> => {
    const accountId = options.readAccountId(),
      held = options.readBoundary()
    if (
      options.confirm &&
      (!held.canSwitch() ||
        !(await options.confirm(
          { accountId, sessionId: request.sessionId, promptId: request.promptId },
          held.canSwitch,
          signal
        )) ||
        options.readAccountId() !== accountId ||
        !held.canSwitch() ||
        signal?.aborted)
    ) {
      return { action: 'none' }
    }
    const phaseId = await options.prepare(request.promptId, accountId)
    if (!phaseId) {
      options.onRefused()
    }
    return phaseId ? { action: 'prepared', phaseId } : { action: 'none' }
  }
}
