import {
  NativeClaudeCanonicalHookSchema,
  type NativeClaudeCanonicalHook
} from '../../../shared/native-claude-canonical-hook'
import type { HookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { normalizeClaudeEvent } from '../../../shared/agent-hook-listener/providers/claude-events'
import { readClaudeBackgroundAgentTasks } from '../../../shared/claude-background-task-inventory'

/** The caller supplies a real host-owned address; this fold never publishes a legacy row. */
export function foldNativeClaudeCanonicalHook(state: HookListenerState, key: string, raw: unknown) {
  const result = NativeClaudeCanonicalHookSchema.safeParse(raw)
  if (!result.success || result.data.nativeOrigin !== 'engine') {
    return null
  }
  const hook = result.data
  const payload = nativeClaudeCanonicalPayload(hook)
  const normalized = normalizeClaudeEvent(state, hook.event, '', key, payload)
  if (!normalized) {
    return null
  }
  const lead = state.claudeLeadStateByPaneKey.get(key)
  const inventory = recordNativeClaudeCanonicalReceipt(state, key, hook, payload)
  return { hook, normalized, lead, inventory }
}

export function nativeClaudeCanonicalPayload(hook: NativeClaudeCanonicalHook) {
  const payload: Record<string, unknown> = {
    session_id: hook.sessionId,
    prompt_id: hook.promptId,
    agent_id: hook.agentId,
    source: hook.source,
    tool_use_id: hook.toolUseId,
    tool_name: hook.toolName,
    error: hook.error
  }
  if (hook.backgroundTasks !== undefined || hook.backgroundTasksTruncated) {
    payload.background_tasks = [
      ...(hook.backgroundTasks ?? []).map((task) => ({
        ...task,
        type:
          task.type === 'agent'
            ? 'subagent'
            : task.type === 'bash' || task.type === 'command'
              ? 'shell'
              : task.type === 'cron'
                ? 'monitor'
                : task.type
      })),
      ...(hook.backgroundTasksTruncated ||
      hook.backgroundTasks?.some((task) => task.type === 'unknown' || task.status === 'unknown')
        ? [{}]
        : [])
    ]
  }
  if (hook.sessionCrons !== undefined || hook.sessionCronsTruncated) {
    payload.session_crons = [
      ...(hook.sessionCrons ?? []).map((id) => ({ id })),
      ...(hook.sessionCronsTruncated ? [{}] : [])
    ]
  }
  return payload
}

export function recordNativeClaudeCanonicalReceipt(
  state: HookListenerState,
  key: string,
  hook: NativeClaudeCanonicalHook,
  payload: Record<string, unknown>
) {
  const lead = state.claudeLeadStateByPaneKey.get(key)
  const inventory = readClaudeBackgroundAgentTasks(payload)
  if (lead && !hook.agentId) {
    const backgroundTasksComplete = inventory.present && !inventory.truncated
    const terminal = hook.event === 'Stop' || hook.event === 'StopFailure'
    lead.nativeHook = {
      event: hook.event,
      sessionId: hook.sessionId,
      promptId: hook.promptId,
      observedAt: Date.now(),
      backgroundTasksComplete,
      sessionCronsComplete:
        !hook.sessionCronsTruncated &&
        (hook.sessionCrons !== undefined ||
          (terminal && backgroundTasksComplete && !state.claudeActiveSessionCronPaneKeys.has(key)))
    }
  }
  return inventory
}
