import { afterEach, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createCodexSubagentTranscriptState,
  reconcileCodexSubagentTranscript
} from './codex-subagent-transcript'
import type { CodexSubagentRoster } from './codex-subagent-roster'
import { readCodexNativeChildInventory } from './codex-native-child-inventory'

const directories: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})
const jsonl = (...items: unknown[]) => items.map((item) => `${JSON.stringify(item)}\n`).join('')
const meta = { type: 'session_meta', payload: { id: 'session-1' } }
const activity = {
  type: 'event_msg',
  payload: { type: 'sub_agent_activity', agent_thread_id: 'child-1', kind: 'started' }
}
const padding = jsonl({ type: 'response_item', payload: { text: 'x'.repeat(1024) } }).repeat(2200)
function fixture(contents = jsonl(meta)) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-native-inventory-'))
  directories.push(directory)
  const parent = join(directory, 'rollout-parent-session-1.jsonl')
  writeFileSync(parent, contents)
  const state = createCodexSubagentTranscriptState(),
    roster: CodexSubagentRoster = new Map()
  const reconcile = () => reconcileCodexSubagentTranscript(state, roster, parent)
  const read = () => readCodexNativeChildInventory(state, roster, 'session-1')
  return { directory, parent, state, roster, reconcile, read }
}
it('requires an existing complete source, session metadata and matching provider session', () => {
  const f = fixture()
  expect(f.read().status).toBe('unverifiable')
  f.reconcile()
  expect(f.read()).toEqual({ status: 'settled' })
  expect(readCodexNativeChildInventory(f.state, f.roster, 'another')).toMatchObject({
    status: 'unverifiable'
  })
  const empty = fixture('')
  empty.reconcile()
  expect(empty.read()).toMatchObject({ status: 'unverifiable', reason: 'session-mismatch' })
})
it('catches up a large resume from true start one bounded chunk at a time and rechecks EOF', () => {
  const f = fixture(jsonl(meta) + padding)
  f.reconcile()
  expect(f.state.parent.offset).toBeLessThanOrEqual(1024 * 1024)
  expect(f.read()).toMatchObject({ status: 'unverifiable', reason: 'history-incomplete' })
  f.reconcile()
  f.reconcile()
  expect(f.read()).toEqual({ status: 'settled' })
  appendFileSync(f.parent, jsonl(activity))
  expect(f.read().status).toBe('unverifiable')
  f.reconcile()
  expect(f.roster.size).toBe(1)
  expect(f.read()).toMatchObject({ status: 'unverifiable' })
})
it.each([
  '{"type":"event_msg","payload":{"type":"sub_agent_activity",broken}\n',
  jsonl({ type: 'event_msg', payload: { type: 'sub_agent_activity', kind: 'started' } })
])('does not certify malformed lifecycle evidence', (bad) => {
  const f = fixture(jsonl(meta) + bad)
  f.reconcile()
  expect(f.read()).toMatchObject({ status: 'unverifiable', reason: 'history-incomplete' })
})
it('rejects truncation and unreadable source even after a previously complete read', () => {
  const f = fixture(jsonl(meta) + padding)
  f.reconcile()
  f.reconcile()
  f.reconcile()
  expect(f.read().status).toBe('settled')
  writeFileSync(f.parent, jsonl(meta))
  f.reconcile()
  expect(f.read().status).toBe('unverifiable')
  unlinkSync(f.parent)
  f.reconcile()
  expect(f.read().status).toBe('unverifiable')
})
it('never certifies a child retired for display after its unreadable grace', () => {
  vi.useFakeTimers()
  const f = fixture(jsonl(meta, activity))
  f.reconcile()
  expect(f.roster.size).toBe(1)
  vi.advanceTimersByTime(61000)
  f.reconcile()
  expect(f.roster.size).toBe(0)
  expect(f.read()).toEqual({ status: 'unverifiable', reason: 'child-settlement-unverifiable' })
})
it('bounds carry on an oversized unterminated line instead of retaining the whole resume', () => {
  const f = fixture(jsonl(meta) + 'x'.repeat(3 * 1024 * 1024))
  for (let i = 0; i < 4; i++) {
    f.reconcile()
    expect(Buffer.byteLength(f.state.parent.carry)).toBeLessThanOrEqual(256 * 1024)
    expect(f.read().status).toBe('unverifiable')
  }
})
it('preserves child completion across bounded catchup chunks without retiring early', () => {
  const f = fixture(jsonl(meta, activity))
  writeFileSync(
    join(f.directory, 'rollout-child-child-1.jsonl'),
    jsonl({ type: 'event_msg', payload: { type: 'task_started' } }) +
      padding +
      jsonl({ type: 'event_msg', payload: { type: 'task_complete' } })
  )
  f.reconcile()
  expect(f.roster.size).toBe(1)
  f.reconcile()
  f.reconcile()
  expect(f.roster.size).toBe(0)
  expect(f.read()).toEqual({ status: 'settled' })
})

it('keeps an outstanding tool live and settles its invocation even when a background resource remains', () => {
  const f = fixture(
    jsonl(meta, {
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: '{}' }
    })
  )
  f.reconcile()
  expect(f.read()).toEqual({ status: 'live' })
  appendFileSync(
    f.parent,
    jsonl({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'Process running with session ID 1234'
      }
    })
  )
  f.reconcile()
  expect(f.read()).toEqual({ status: 'settled' })
})

it('keeps malformed or unmatched tool settlement evidence unverifiable', () => {
  const f = fixture(
    jsonl(meta, {
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'unseen', output: 'done' }
    })
  )
  f.reconcile()
  expect(f.read()).toEqual({ status: 'unverifiable', reason: 'tool-settlement-unverified' })
})

it('validates large image/message records incrementally without retaining their content', () => {
  const image = '😀'.repeat(800000)
  const f = fixture(
    jsonl(meta, {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: image }]
      }
    })
  )
  for (let i = 0; i < 4; i++) {
    f.reconcile()
    expect(Buffer.byteLength(f.state.parent.carry)).toBeLessThanOrEqual(256 * 1024)
  }
  expect(f.read()).toEqual({ status: 'settled' })
})

it('settles a large tool output only after the entire valid JSON record arrives', () => {
  const f = fixture(
    jsonl(meta, {
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'large-output' }
    })
  )
  f.reconcile()
  const output = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'large-output',
      output: 'x'.repeat(1500000)
    }
  })
  appendFileSync(f.parent, output.slice(0, -1))
  f.reconcile()
  f.reconcile()
  expect(f.read()).toEqual({ status: 'live' })
  appendFileSync(f.parent, '}\n')
  f.reconcile()
  expect(f.read()).toEqual({ status: 'settled' })
})

it.each(['unknown_lifecycle', 'sub_agent_activity'])(
  'rejects malformed oversized lifecycle %s',
  (type) => {
    const f = fixture(
      `${
        jsonl(meta) +
        JSON.stringify({
          type: 'event_msg',
          payload: { type, padding: 'x'.repeat(300000) }
        }).slice(0, -1)
      },broken}\n`
    )
    f.reconcile()
    expect(f.read().status).toBe('unverifiable')
  }
)

it('validates large persisted compaction history without replaying its historical tool items', () => {
  const f = fixture(
    jsonl(meta, {
      type: 'compacted',
      payload: {
        message: 'summary',
        replacement_history: [
          { type: 'message', content: [{ type: 'input_image', image_url: 'x'.repeat(400000) }] }
        ]
      }
    })
  )
  f.reconcile()
  expect(f.read()).toEqual({ status: 'settled' })
})

it('keeps a trailing incomplete UTF-8 byte outside a record unverifiable', () => {
  const f = fixture()
  f.reconcile()
  appendFileSync(f.parent, Buffer.from([0xf0]))
  f.reconcile()
  expect(f.read()).toEqual({ status: 'unverifiable', reason: 'history-incomplete' })
})
