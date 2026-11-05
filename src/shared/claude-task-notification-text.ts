/** Claude tells a parent agent about a background task with a user turn that starts with this tag. */
export const CLAUDE_TASK_NOTIFICATION_MARKER = '<task-notification>'
const TASK_ID_PATTERN = /<task-id>([^<]+)<\/task-id>/
const TASK_STATUS_PATTERN = /<status>([a-z_]+)<\/status>/

/** `status` is present only once the task has ended: a Monitor's `<event>` turns reuse the tag and
 *  the task id while the task is still running (captured on Claude Code 2.1.287). Claude writes it
 *  before `<summary>`; anything after is task output, which may itself contain a status tag. */
export function readClaudeTaskNotification(
  text: string
): { taskId: string; status?: string } | null {
  return parseTaskNotification(
    text,
    CLAUDE_TASK_NOTIFICATION_MARKER,
    TASK_ID_PATTERN,
    TASK_STATUS_PATTERN
  )
}

function parseTaskNotification(
  text: string,
  marker: string,
  idPattern: RegExp,
  statusPattern: RegExp
): { taskId: string; status?: string } | null {
  if (!text.startsWith(marker)) {
    return null
  }
  const taskId = idPattern.exec(text)?.[1]?.trim()
  if (!taskId) {
    return null
  }
  const summaryAt = text.indexOf('<summary>')
  const status = statusPattern.exec(summaryAt === -1 ? text : text.slice(0, summaryAt))?.[1]
  return { taskId, ...(status ? { status } : {}) }
}

/** Ship the same pure parser into the native sandbox, which cannot import host TypeScript. */
export function nativeClaudeTaskNotificationParserSource(): string {
  return `const parse = ${parseTaskNotification.toString()};
const marker = ${JSON.stringify(CLAUDE_TASK_NOTIFICATION_MARKER)};
const id = new RegExp(${JSON.stringify(TASK_ID_PATTERN.source)});
const status = new RegExp(${JSON.stringify(TASK_STATUS_PATTERN.source)});
export function readClaudeTaskNotification(text) { return parse(text, marker, id, status) }
`
}
