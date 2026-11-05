import { Readable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { runNativeClaudePoolHook } from './native-claude-pool-hook'
import type { RuntimeClient } from './runtime-client'

const launchId = '12345678-1234-4234-8234-123456789012'
const phaseId = '22345678-1234-4234-8234-123456789012'
const marker = `<opka-native-wake:v1:${phaseId}:1:${'a'.repeat(64)}>`
function fixture(
  payload: Record<string, unknown> = {},
  results: unknown[] = [{ action: 'allow' }]
) {
  const call = vi.fn(async () => ({
    id: 'r',
    ok: true,
    result: results.shift(),
    _meta: { runtimeId: 'runtime' }
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies the only used RPC call surface and never connects to a runtime.
  const client = { call } as unknown as Pick<RuntimeClient, 'call'>
  const stdout: string[] = []
  const stderr: string[] = []
  const io = {
    stdin: Readable.from([
      JSON.stringify({ session_id: 'session', prompt_id: 'prompt', ...payload })
    ]),
    env: { OPKA_CLAUDE_ROUTING_KEY: 'synthetic-owned-capability-'.repeat(2) },
    stdout: (text: string) => {
      stdout.push(text)
    },
    stderr: (text: string) => {
      stderr.push(text)
    }
  }
  return { client, call, stdout, stderr, io }
}
it('keeps original user prompts out of RPC and output', async () => {
  const f = fixture({ prompt: 'unique private user input' })
  expect(await runNativeClaudePoolHook(f.client, [launchId, 'prompt'], f.io)).toBe(0)
  expect(JSON.stringify(f.call.mock.calls)).not.toContain('unique private user input')
  expect(f.stdout).toEqual([])
  expect(f.stderr).toEqual([])
})
it('forwards only the opaque marker and hides the blocked internal prompt from native output', async () => {
  const f = fixture({ prompt: `Continue an existing task. ${marker}` }, [{ action: 'block' }])
  expect(await runNativeClaudePoolHook(f.client, [launchId, 'prompt'], f.io)).toBe(0)
  expect(f.call).toHaveBeenCalledWith(
    'accounts.nativeClaudeHook',
    expect.objectContaining({ wakeMarker: marker }),
    expect.anything()
  )
  expect(JSON.parse(f.stdout.join(''))).toMatchObject({
    decision: 'block',
    hookSpecificOutput: { suppressOriginalPrompt: true }
  })
  expect(f.stdout.join('')).not.toContain(marker)
})
it('claims the prepared failure wake just before exit2 without leaking invalid extra fields', async () => {
  const f = fixture({ error: 'rate_limit' }, [
    { action: 'prepared', phaseId },
    { action: 'wake', marker }
  ])
  expect(await runNativeClaudePoolHook(f.client, [launchId, 'failure'], f.io)).toBe(2)
  expect(f.call).toHaveBeenLastCalledWith(
    'accounts.nativeClaudeHook',
    expect.objectContaining({ event: 'claim-wake', phaseId, step: 1 }),
    expect.anything()
  )
  expect(JSON.stringify(f.call.mock.calls.at(-1))).not.toContain('rate_limit')
  expect(f.stderr.join('')).toContain(marker)
})
it('does not wake for an unrelated failure or child agent', async () => {
  for (const payload of [{ error: 'overloaded' }, { agent_id: 'child', error: 'rate_limit' }]) {
    const f = fixture(payload)
    expect(await runNativeClaudePoolHook(f.client, [launchId, 'failure'], f.io)).toBe(0)
    expect(f.call).not.toHaveBeenCalled()
  }
})
it('returns a generic unavailable error instead of a native auth or RPC cause', async () => {
  const f = fixture({ prompt: 'private input' })
  f.call.mockRejectedValue(new Error('private auth code#state'))
  expect(await runNativeClaudePoolHook(f.client, [launchId, 'prompt'], f.io)).toBe(0)
  expect(f.stderr.join('')).toBe('')
  expect(JSON.parse(f.stdout.join(''))).toEqual({
    decision: 'block',
    reason: 'Account host unavailable; reconnect or restart this native session.'
  })
  expect(f.stdout.join('')).not.toContain('private')
})

it('does not autonomously wake after a broker failure', async () => {
  const f = fixture({ error: 'rate_limit' })
  f.call.mockRejectedValue(new Error('private provider response'))
  expect(await runNativeClaudePoolHook(f.client, [launchId, 'failure'], f.io)).toBe(1)
  expect(f.stdout.join('')).toBe('')
  expect(f.stderr.join('')).toBe('Managed Claude account preparation is unavailable.\n')
})
