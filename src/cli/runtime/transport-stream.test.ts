import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { afterEach, expect, it } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { UnixSocketTransport } from '../../main/runtime/rpc/unix-socket-transport'
import { sendRequest } from './transport'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close()
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opka-native-stream-'))
  const endpoint = join(root, 'rpc.sock')
  const transport = new UnixSocketTransport({ endpoint, kind: 'unix', keepaliveIntervalMs: 10 })
  await transport.start()
  cleanup.push(async () => {
    await transport.stop()
    await rm(root, { recursive: true, force: true })
  })
  const metadata: RuntimeMetadata = {
    runtimeId: 'synthetic',
    pid: 1,
    transports: [{ kind: 'unix', endpoint }],
    authToken: 'synthetic-only',
    startedAt: 1
  }
  return { transport, metadata }
}
it.skipIf(process.platform === 'win32')(
  'streams every ANSI frame before its final response and honors async consumption',
  async () => {
    const f = await fixture()
    f.transport.onMessage((raw, reply, context) => {
      const { id } = z.object({ id: z.string() }).parse(JSON.parse(raw))
      context?.startKeepalive()
      const frame = (result: unknown) =>
        JSON.stringify({ id, ok: true, result, streaming: true, _meta: { runtimeId: 'synthetic' } })
      context?.emit?.(frame({ type: 'data', chunk: '\x1b[31mfirst' }))
      context?.emit?.(frame({ type: 'data', chunk: '\x1b[0msecond' }))
      reply(
        JSON.stringify({
          id,
          ok: true,
          result: { completed: true },
          _meta: { runtimeId: 'synthetic' }
        })
      )
    })
    const frames: unknown[] = []
    const response = await sendRequest(
      f.metadata,
      'accounts.attachNativeCliTerminal',
      {},
      1000,
      undefined,
      undefined,
      {
        onFrame: async (result) => {
          await Promise.resolve()
          frames.push(result)
        }
      }
    )
    expect(frames).toEqual([
      { type: 'data', chunk: '\x1b[31mfirst' },
      { type: 'data', chunk: '\x1b[0msecond' }
    ])
    expect(response.ok).toBe(true)
  }
)
it.skipIf(process.platform === 'win32')(
  'detaches an aborted stream without treating contact loss as process exit',
  async () => {
    const f = await fixture()
    const controller = new AbortController()
    f.transport.onMessage((raw, _reply, context) => {
      const { id } = z.object({ id: z.string() }).parse(JSON.parse(raw))
      context?.startKeepalive()
      context?.emit?.(
        JSON.stringify({
          id,
          ok: true,
          result: { type: 'data', chunk: 'synthetic' },
          streaming: true,
          _meta: { runtimeId: 'synthetic' }
        })
      )
    })
    await expect(
      sendRequest(f.metadata, 'accounts.attachNativeCliTerminal', {}, 1000, undefined, undefined, {
        onFrame: () => controller.abort(),
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: 'runtime_stream_aborted' })
  }
)
