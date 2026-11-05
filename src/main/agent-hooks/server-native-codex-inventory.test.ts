import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
const directories: string[] = []
afterEach(() => {
  _internals.resetCachesForTests()
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})
it('verifies native child evidence against the exact legacy hook row without minting an execution ID', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-codex-hook-inventory-'))
  directories.push(directory)
  const transcript = join(directory, 'rollout-native-session-1.jsonl')
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-1' } })}\n`
  )
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  try {
    for (const event of ['UserPromptSubmit', 'Stop']) {
      await postHookEvent(
        server,
        buildBody({
          hook_event_name: event,
          session_id: 'session-1',
          transcript_path: transcript,
          prompt: 'synthetic'
        }),
        '/hook/codex'
      )
    }
    const row = server.getStatusSnapshotForPane(PANE)[0]
    expect(row.executionId).toBeUndefined()
    expect(server.readNativeCodexChildInventory(row)).toEqual({ status: 'settled' })
    expect(server.getStatusSnapshotForPane(PANE)).toHaveLength(1)
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'turn_context',
        payload: { model: 'synthetic-updated-before-http' }
      })  }\n`
    )
    expect(server.readNativeCodexChildInventory(row)).toEqual({ status: 'settled' })
    expect(
      server.readNativeCodexChildInventory({ ...row, receivedAt: row.receivedAt - 1 })
    ).toMatchObject({ status: 'unverifiable' })
    expect(
      server.readNativeCodexChildInventory({ ...row, connectionId: 'other-host' })
    ).toMatchObject({ status: 'unverifiable' })
    expect(server.readNativeCodexChildInventory({ ...row, isReplay: true })).toMatchObject({
      status: 'unverifiable'
    })
    await postHookEvent(
      server,
      buildBody({ hook_event_name: 'SubagentStart', session_id: 'session-1', agent_id: 'child-1' }),
      '/hook/codex'
    )
    expect(server.readNativeCodexChildInventory(server.getStatusSnapshotForPane(PANE)[0])).toEqual({
      status: 'live'
    })
  } finally {
    server.stop()
  }
})
