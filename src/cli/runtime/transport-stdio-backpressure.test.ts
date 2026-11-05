import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { UnixSocketTransport } from '../../main/runtime/rpc/unix-socket-transport'
import { sendRequest } from './transport'
const cleanup: (() => Promise<void>)[] = []
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
async function until(ready: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (ready()) {
      return
    }
    await turn()
  }
  throw new Error('Synthetic socket did not reach its expected phase')
}
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0)) {
    await close()
  }
})
async function fixture({ final = true, output = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'opka-stdio-pressure-'))
  const endpoint = join(root, 'rpc.sock')
  const transport = new UnixSocketTransport({ endpoint, kind: 'unix' })
  await transport.start()
  cleanup.push(async () => {
    await transport.stop()
    await rm(root, { recursive: true, force: true })
  })
  let received = false
  transport.onMessage((raw, reply, context) => {
    received = true
    const { id } = z.object({ id: z.string() }).parse(JSON.parse(raw))
    if (output) {
      context?.emit?.(
        JSON.stringify({
          id,
          ok: true,
          result: { type: 'bytes' },
          streaming: true,
          _meta: { runtimeId: 'synthetic' }
        })
      )
    }
    if (final) {
      reply(
        JSON.stringify({ id, ok: true, result: { done: true }, _meta: { runtimeId: 'synthetic' } })
      )
    }
  })
  const metadata: RuntimeMetadata = {
    runtimeId: 'synthetic',
    pid: 1,
    transports: [{ kind: 'unix', endpoint }],
    authToken: 'synthetic-only',
    startedAt: 1
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  let release = () => {},
    consuming = false,
    consumed = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const stream = {
    pauseTimeoutWhileConsuming: true,
    onFrame: async () => {
      consuming = true
      await gate
      consumed = true
    }
  }
  return {
    transport,
    metadata,
    stream,
    release,
    consuming: () => consuming,
    consumed: () => consumed,
    received: () => received
  }
}
it.skipIf(process.platform === 'win32')(
  'suspends only the opted-in consumer timeout and resumes a complete response',
  async () => {
    const f = await fixture()
    let settled = false
    const pending = sendRequest(f.metadata, 'stdio', {}, 50, undefined, undefined, f.stream)
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await until(f.consuming)
    await vi.advanceTimersByTimeAsync(500)
    expect(settled).toBe(false)
    f.release()
    expect((await pending).ok).toBe(true)
  }
)
it.skipIf(process.platform === 'win32')(
  'keeps the existing deadline for consumers that did not opt in',
  async () => {
    const f = await fixture()
    const pending = sendRequest(f.metadata, 'ordinary-stream', {}, 50, undefined, undefined, {
      ...f.stream,
      pauseTimeoutWhileConsuming: false
    })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'runtime_timeout' })
    await until(f.consuming)
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    f.release()
  }
)
it.skipIf(process.platform === 'win32')(
  'retains the finite initial deadline before any consumer starts',
  async () => {
    const f = await fixture({ output: false, final: false })
    const pending = sendRequest(f.metadata, 'stdio', {}, 50, undefined, undefined, f.stream)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'runtime_timeout' })
    await until(f.received)
    await vi.advanceTimersByTimeAsync(100)
    await rejected
  }
)
it.skipIf(process.platform === 'win32')(
  'rearms finite inactivity after the consumer finishes',
  async () => {
    const f = await fixture({ final: false })
    const pending = sendRequest(f.metadata, 'stdio', {}, 50, undefined, undefined, f.stream)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'runtime_timeout' })
    await until(f.consuming)
    await vi.advanceTimersByTimeAsync(500)
    f.release()
    await until(f.consumed)
    await turn()
    await vi.advanceTimersByTimeAsync(100)
    await rejected
  }
)
it.skipIf(process.platform === 'win32')(
  'honors explicit abort while the consumer remains blocked',
  async () => {
    const f = await fixture(),
      controller = new AbortController()
    const pending = sendRequest(f.metadata, 'stdio', {}, 50, undefined, undefined, {
      ...f.stream,
      signal: controller.signal
    })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'runtime_stream_aborted' })
    await until(f.consuming)
    controller.abort()
    await rejected
    f.release()
    await vi.advanceTimersByTimeAsync(500)
  }
)
it.skipIf(process.platform === 'win32')(
  'reports a disconnected peer after the admitted consumer resumes',
  async () => {
    const f = await fixture({ final: false })
    const pending = sendRequest(f.metadata, 'stdio', {}, 50, undefined, undefined, f.stream)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'runtime_unavailable' })
    await until(f.consuming)
    await f.transport.stop()
    f.release()
    await rejected
  }
)
