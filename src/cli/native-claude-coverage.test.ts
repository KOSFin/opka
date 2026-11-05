import { Readable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import type { RuntimeClient } from './runtime-client'
import { runNativeClaudeCoverage } from './native-claude-coverage'

const launchId = '11111111-1111-4111-8111-111111111111'
function fixture(
  body: Record<string, unknown> = {},
  acknowledgement: unknown = { sequence: 1, healthy: true }
) {
  const call = vi.fn(async () => ({
    id: 'request',
    ok: true,
    result: acknowledgement,
    _meta: { runtimeId: 'host' }
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This synthetic client exposes only the exercised RPC call and never opens a transport.
  const client = { call } as unknown as Pick<RuntimeClient, 'call'>
  const stdout: string[] = [],
    stderr: string[] = []
  const io = {
    stdin: Readable.from([
      JSON.stringify({
        sessionId: 'actual-native-root',
        generation: '22222222-2222-4222-8222-222222222222',
        sequence: 1,
        observation: { kind: 'tool-start', id: 'actual-tool-id', tool: 'Bash' },
        ...body
      })
    ]),
    env: { OPKA_CLAUDE_ROUTING_KEY: 'x'.repeat(64) },
    stdout: (text: string) => {
      stdout.push(text)
    },
    stderr: (text: string) => {
      stderr.push(text)
    }
  }
  return { call, client, stdout, stderr, io }
}
it('requires an exact host acknowledgement before native execution may continue', async () => {
  const f = fixture()
  expect(await runNativeClaudeCoverage(f.client, [launchId], f.io)).toBe(0)
  expect(f.call).toHaveBeenCalledWith(
    'accounts.nativeClaudeCoverage',
    expect.objectContaining({ launchId, sequence: 1, capability: 'x'.repeat(64) }),
    expect.anything()
  )
  expect(JSON.parse(f.stdout.join(''))).toEqual({ sequence: 1, healthy: true })
})
it('accepts an explicit pinned verdict but refuses wrong acknowledgements and broker errors', async () => {
  const pinned = fixture({}, { sequence: 1, healthy: false })
  expect(await runNativeClaudeCoverage(pinned.client, [launchId], pinned.io)).toBe(0)
  for (const ack of [{ sequence: 2, healthy: true }, { arbitrary: true }]) {
    const f = fixture({}, ack)
    expect(await runNativeClaudeCoverage(f.client, [launchId], f.io)).toBe(1)
  }
  const f = fixture()
  f.call.mockRejectedValue(new Error('synthetic-private-host-cause'))
  expect(await runNativeClaudeCoverage(f.client, [launchId], f.io)).toBe(1)
  expect(f.stderr.join('')).not.toContain('synthetic-private')
})
it('never forwards prompts, unexpected keys or oversized metadata', async () => {
  for (const body of [
    { prompt: 'synthetic-private-input' },
    { 'synthetic-private-key': true },
    { unexpected: 'x'.repeat(256 * 1024) }
  ]) {
    const f = fixture(body)
    expect(await runNativeClaudeCoverage(f.client, [launchId], f.io)).toBe(1)
    expect(f.call).not.toHaveBeenCalled()
    expect(f.stdout.join('')).toBe('')
    expect(f.stderr.join('')).not.toContain('synthetic-private')
  }
})
