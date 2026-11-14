import { afterEach, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { createNativeCodexInventorySource } from './native-codex-inventory-source'
import { AgentHookServer } from './server'
const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})
const session = '11111111-1111-4111-8111-111111111111'
const jsonl = (...values: unknown[]) => values.map((value) => `${JSON.stringify(value)}\n`).join('')
const meta = { type: 'session_meta', payload: { id: session } }
const started = { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-0' } }
const ended = { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-0' } }
function fixture(contents = jsonl(meta, started, ended), indexedPath?: string) {
  const home = mkdtempSync(join(tmpdir(), 'native-owned-source-'))
  directories.push(home)
  const directory = join(home, 'sessions', '2026', '11', '05')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `rollout-native-${session}.jsonl`)
  writeFileSync(path, contents)
  const db = new SyncDatabase(join(home, 'state_5.sqlite'))
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT NOT NULL)')
  db.prepare('INSERT INTO threads VALUES(?,?)').run(session, indexedPath ?? path)
  db.close()
  const state = createHookListenerState()
  let current = true,
    releases = 0
  const source = createNativeCodexInventorySource(
    state,
    { home, launchId: 'launch-1', isCurrent: () => current },
    () => {
      releases++
    }
  )
  source.bindRoot(session)
  return {
    home,
    path,
    state,
    source,
    setCurrent: (value: boolean) => {
      current = value
    },
    released: () => releases
  }
}
it('uses the exact indexed native source and rejects a newer unaccepted main task for an old Stop', async () => {
  const f = fixture()
  try {
    await f.source.prepare(new AbortController().signal)
    expect(f.source.readTurn('turn-0')).toBe(true)
    expect(f.source.readBoundaryTurn('turn-0')).toBe(true)
    appendFileSync(
      f.path,
      jsonl({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } })
    )
    expect(f.source.readBoundaryTurn('turn-0')).toBe(false)
    expect(f.source.readBoundaryTurn('turn-0', undefined, 'turn-1')).toBe(true)
    f.setCurrent(false)
    expect(f.source.read().status).toBe('unverifiable')
  } finally {
    f.source.dispose()
  }
  expect(f.released()).toBe(1)
  expect(f.state.codexSubagentTranscriptByPaneKey.size).toBe(0)
})
it('bounds total resumed transcript reads with a shared budget and can catch up later', async () => {
  const padding = jsonl({
    type: 'response_item',
    payload: { type: 'message', text: 'x'.repeat(1024) }
  }).repeat(11000)
  const f = fixture(jsonl(meta) + padding + jsonl(ended))
  try {
    const budget = { remainingBytes: 2 * 1024 * 1024 }
    await f.source.prepare(new AbortController().signal, budget)
    expect(budget.remainingBytes).toBe(0)
    expect(f.source.read({ remainingBytes: 0 }).status).toBe('unverifiable')
    await f.source.prepare(new AbortController().signal, { remainingBytes: 8 * 1024 * 1024 })
    await f.source.prepare(new AbortController().signal, { remainingBytes: 8 * 1024 * 1024 })
    expect(f.source.readTurn('turn-0')).toBe(true)
  } finally {
    f.source.dispose()
  }
})
it('rejects an indexed path outside the trusted history home and only discovers its verified local source', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'native-foreign-source-'))
  directories.push(outside)
  const foreign = join(outside, `rollout-${session}.jsonl`)
  writeFileSync(foreign, jsonl(meta, ended))
  const f = fixture(jsonl(meta), foreign)
  try {
    await f.source.prepare(new AbortController().signal)
    expect(f.source.readTurn('turn-0')).toBe(false)
    appendFileSync(f.path, jsonl(ended))
    expect(f.source.readTurn('turn-0')).toBe(true)
  } finally {
    f.source.dispose()
  }
})
it('keeps first missing root unrepairable and cancellation/disposal clears only its own caches', async () => {
  const f = fixture()
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(f.source.prepare(cancelled.signal)).rejects.toThrow()
  f.source.dispose()
  f.source.dispose()
  expect(f.released()).toBe(1)
  const source = createNativeCodexInventorySource(
    f.state,
    { home: f.home, launchId: 'second', isCurrent: () => true },
    () => {}
  )
  try {
    source.bindRoot(null)
    expect(() => source.bindRoot(session)).toThrow('already bound')
    expect(source.read().status).toBe('unverifiable')
  } finally {
    source.dispose()
  }
})
it('registers 100 inventory sources while rejecting duplicate launch ownership', () => {
  const server = new AgentHookServer()
  const home = mkdtempSync(join(tmpdir(), 'native-source-capacity-'))
  directories.push(home)
  const sources = Array.from({ length: 100 }, (_, index) =>
    server.registerNativeCodexInventorySource({
      home,
      launchId: `launch-${index}`,
      isCurrent: () => true
    })
  )
  try {
    expect(() =>
      server.registerNativeCodexInventorySource({
        home,
        launchId: 'launch-0',
        isCurrent: () => true
      })
    ).toThrow('ownership')
    sources[0].dispose()
    const extra = server.registerNativeCodexInventorySource({
      home,
      launchId: 'overflow',
      isCurrent: () => true
    })
    extra.dispose()
  } finally {
    sources.forEach((source) => source.dispose())
  }
})

it('retains an explicit interrupted terminal across later turns without settling its pending tool', async () => {
  const f = fixture(
    jsonl(
      meta,
      started,
      { type: 'response_item', payload: { type: 'function_call', call_id: 'cancelled-tool' } },
      {
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: 'turn-0', reason: 'interrupted' }
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }
    )
  )
  try {
    await f.source.prepare(new AbortController().signal)
    expect(f.source.readBoundaryTurn('turn-0')).toBe(false)
    appendFileSync(
      f.path,
      jsonl({
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'cancelled-tool', output: 'interrupted' }
      })
    )
    expect(f.source.readBoundaryTurn('turn-0')).toBe(true)
    const transcript = [...f.state.codexSubagentTranscriptByPaneKey.values()][0]
    expect(transcript?.turnEnds.get('turn-0')).toBe('failed')
    appendFileSync(
      f.path,
      jsonl({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } })
    )
    expect(f.source.readBoundaryTurn('turn-0')).toBe(false)
  } finally {
    f.source.dispose()
  }
})
