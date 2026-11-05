import { FlexAssembler, objectRule } from 'stream-json/core/utils/flex-assembler.js'
import { createJsonTokenReader } from './json-token-reader'
import type { JsonRecord } from './codex-rollout-jsonl-cursor'

const lifecycleFields = new Set([
  'type',
  'id',
  'call_id',
  'turn_id',
  'agent_thread_id',
  'kind',
  'agent_path',
  'occurred_at_ms',
  'reason',
  'model',
  'approvals_reviewer',
  'error',
  'output'
])
const events = new Set([
  'sub_agent_activity',
  'task_started',
  'turn_started',
  'task_complete',
  'turn_complete',
  'turn_aborted',
  'thread_settings_applied',
  'agent_message',
  'user_message',
  'token_count'
])
const responses = new Set([
  'message',
  'reasoning',
  'compaction',
  'context_compaction',
  'function_call',
  'custom_tool_call',
  'function_call_output',
  'custom_tool_call_output'
])

/** Validate the whole record while retaining only bounded lifecycle evidence. */
export function createCodexStreamedRolloutRecord() {
  const root: JsonRecord = Object.create(null)
  let payload: JsonRecord | undefined
  const retained = (path: (string | number)[]) =>
    (path.length === 1 && (path[0] === 'type' || path[0] === 'timestamp')) ||
    (path.length === 2 && path[0] === 'payload' && lifecycleFields.has(String(path[1]))) ||
    (path.length === 3 &&
      path[0] === 'payload' &&
      path[1] === 'thread_settings' &&
      path[2] === 'approvals_reviewer')
  const discard = {
    filter: () => true,
    create: (path: (string | number)[]) =>
      path.length === 2 && path[0] === 'payload' && path[1] === 'error' ? true : null,
    add: () => {}
  }
  const assembler = new FlexAssembler({
    maxDepth: 64,
    objectRules: [
      objectRule<JsonRecord>({
        filter: (path) => path.length === 0,
        create: () => root,
        add: (target, key, value) => {
          if (key === 'type' || key === 'timestamp' || key === 'payload') {
            target[key] = value
          }
        }
      }),
      objectRule<JsonRecord>({
        filter: (path) => path.length === 1 && path[0] === 'payload',
        create: () => (payload = Object.create(null)),
        add: (target, key, value) => {
          if (lifecycleFields.has(key) || key === 'thread_settings') {
            target[key] = value
          }
        }
      }),
      objectRule<JsonRecord>({
        filter: (path) =>
          path.length === 2 && path[0] === 'payload' && path[1] === 'thread_settings',
        create: () => Object.create(null),
        add: (target, key, value) => {
          if (key === 'approvals_reviewer') {
            target[key] = value
          }
        }
      }),
      discard
    ],
    arrayRules: [
      {
        filter: (path) => path.length === 2 && path[0] === 'payload' && path[1] === 'output',
        create: () => [],
        add: () => {}
      },
      discard
    ]
  })
  const reader = createJsonTokenReader(
    (token) => assembler.consume(token),
    16384,
    () => {
      const key = assembler.isArray ? assembler.arrayIndex + 1 : assembler.key
      return key !== null && key !== 'output' && retained([...assembler.path, key])
    },
    4096
  )
  return {
    write: reader.write,
    end(): JsonRecord {
      reader.end()
      const valid =
        assembler.current === root &&
        root.payload === payload &&
        payload &&
        (root.type === 'session_meta' ||
          root.type === 'compacted' ||
          root.type === 'turn_context' ||
          (root.type === 'event_msg' &&
            typeof payload.type === 'string' &&
            events.has(payload.type)) ||
          (root.type === 'response_item' &&
            typeof payload.type === 'string' &&
            responses.has(payload.type)))
      if (!valid) {
        throw new SyntaxError('Oversized rollout record has unknown lifecycle structure')
      }
      return root
    }
  }
}
