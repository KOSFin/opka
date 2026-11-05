import { classifyClaudeBackgroundTaskKind } from './claude-background-task-kind'
import { CLAUDE_TERMINAL_BACKGROUND_TASK_STATUSES } from './claude-background-task-inventory'

export function nativeClaudeMetadataField(value: unknown, max: number) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : undefined
}

/** Strip native payloads to bounded lifecycle facts before they leave the provider process. */
export function nativeClaudeCanonicalMetadata(
  event: string,
  payload: Record<string, unknown>,
  nativeOrigin: 'engine' | 'plugin' | 'unverifiable',
  classifyTask: (value: unknown) => string,
  terminal: ReadonlySet<string>,
  field: typeof nativeClaudeMetadataField
) {
  const agentId = field(payload.agent_id, 64)
  const toolUseId = field(payload.tool_use_id, 128)
  const toolName = field(payload.tool_name, 128)
  const unverifiable = [
    [payload.agent_id, agentId],
    [payload.tool_use_id, toolUseId],
    [payload.tool_name, toolName]
  ].some(([raw, value]) => raw !== undefined && raw !== null && raw !== '' && value === undefined)
  let backgroundTasksTruncated = false
  const backgroundTasks = Array.isArray(payload.background_tasks)
    ? payload.background_tasks.slice(0, 64).map((raw: unknown) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          backgroundTasksTruncated = true
          return { type: 'unknown', status: 'unknown' }
        }
        const item: Record<string, unknown> = { ...raw }
        const type = field(item.type, 64)?.toLowerCase()
        const status = field(item.status, 64)?.toLowerCase()
        const kind = classifyTask(type)
        const id = field(item.id, 64)
        if (!type || !status || (kind === 'agent' && !id)) {
          backgroundTasksTruncated = true
        }
        return {
          id,
          type:
            type === 'teammate'
              ? 'teammate'
              : kind === 'agent'
                ? 'agent'
                : kind === 'command'
                  ? 'shell'
                  : kind === 'monitor'
                    ? 'cron'
                    : type
                      ? 'other'
                      : 'unknown',
          status:
            status && terminal.has(status)
              ? ['failed', 'error', 'crashed', 'timed_out'].includes(status)
                ? 'failed'
                : ['cancelled', 'canceled', 'aborted', 'killed', 'terminated'].includes(status)
                  ? 'cancelled'
                  : 'completed'
              : status === 'running' || status === 'pending'
                ? status
                : 'unknown'
        }
      })
    : undefined
  backgroundTasksTruncated ||= Array.isArray(payload.background_tasks)
    ? payload.background_tasks.length > 64
    : payload.background_tasks !== undefined
  let sessionCronsTruncated = false
  const sessionCrons = Array.isArray(payload.session_crons)
    ? payload.session_crons.slice(0, 64).flatMap((raw: unknown) => {
        const id = raw && typeof raw === 'object' && 'id' in raw ? field(raw.id, 64) : undefined
        if (!id) {
          sessionCronsTruncated = true
        }
        return id ? [id] : []
      })
    : undefined
  sessionCronsTruncated ||= Array.isArray(payload.session_crons)
    ? payload.session_crons.length > 64
    : payload.session_crons !== undefined
  const source = ['startup', 'resume', 'clear', 'compact', 'fork'].includes(String(payload.source))
    ? payload.source
    : 'unknown'
  return {
    nativeOrigin: unverifiable ? 'unverifiable' : nativeOrigin,
    event,
    sessionId: payload.session_id,
    promptId: payload.prompt_id,
    agentId,
    toolUseId,
    toolName,
    ...(event === 'SessionStart' ? { source } : {}),
    ...(event === 'StopFailure'
      ? { error: payload.error === 'rate_limit' ? 'rate_limit' : 'other' }
      : {}),
    backgroundTasks,
    ...(backgroundTasksTruncated ? { backgroundTasksTruncated: true } : {}),
    sessionCrons,
    ...(sessionCronsTruncated ? { sessionCronsTruncated: true } : {})
  }
}

export function nativeClaudeCanonicalMetadataSource(): string {
  return `const nativeField=${nativeClaudeMetadataField.toString()};
const classifyNativeTask=${classifyClaudeBackgroundTaskKind.toString()};
const nativeTerminalStatuses=new Set(${JSON.stringify([...CLAUDE_TERMINAL_BACKGROUND_TASK_STATUSES])});
const nativeMetadata=${nativeClaudeCanonicalMetadata.toString()};
const canonicalMetadata=(event,payload,origin)=>nativeMetadata(event,payload,origin,classifyNativeTask,nativeTerminalStatuses,nativeField);`
}
