import './rpc/unused-default-rpc-methods.test-fixture'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { readRuntimeMetadata } from './runtime-metadata'
import { defineMethod, defineStreamingMethod, type RpcContext } from './rpc/core'
import { sendRequest } from '../../cli/runtime/transport'
import { assertNativeCliLocalCaller } from './rpc/methods/native-cli-accounts'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})
async function fixture() {
  const userDataPath = await mkdtemp(join(tmpdir(), 'opka-native-admission-'))
  const stream = vi.fn(
    async (_params: unknown, context: RpcContext, emit: (value: unknown) => void) => {
      assertNativeCliLocalCaller(context)
      emit({ type: 'data', chunk: '\x1b[32msynthetic' })
      emit({ type: 'native-cli-exit', code: 19 })
    }
  )
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: false,
    methods: [
      defineStreamingMethod({
        name: 'accounts.attachNativeCliTerminal',
        permission: 'workspace',
        params: z.object({}),
        handler: stream
      }),
      defineMethod({
        name: 'synthetic.unary',
        permission: 'workspace',
        params: z.object({}),
        handler: () => ({ ordinary: true })
      })
    ]
  })
  await server.start()
  cleanups.push(async () => {
    await server.stop()
    await rm(userDataPath, { recursive: true, force: true })
  })
  const metadata = readRuntimeMetadata(userDataPath)
  if (!metadata) {
    throw new Error('Missing synthetic runtime metadata')
  }
  return { metadata, stream }
}
it('authenticates a local streaming dispatch and preserves the ordinary unary response', async () => {
  const f = await fixture()
  const frames: unknown[] = []
  const response = await sendRequest(
    f.metadata,
    'accounts.attachNativeCliTerminal',
    {},
    1000,
    undefined,
    undefined,
    {
      onFrame: (frame) => {
        frames.push(frame)
      }
    }
  )
  expect(frames).toEqual([
    { type: 'data', chunk: '\x1b[32msynthetic' },
    { type: 'native-cli-exit', code: 19 }
  ])
  expect(response).toMatchObject({ ok: true, result: { completed: true } })
  expect(f.stream).toHaveBeenCalledOnce()
  expect(await sendRequest(f.metadata, 'synthetic.unary', {}, 1000)).toMatchObject({
    ok: true,
    result: { ordinary: true }
  })
})
it('refuses an invalid local token before invoking or emitting from the streaming handler', async () => {
  const f = await fixture()
  const onFrame = vi.fn()
  expect(
    await sendRequest(
      { ...f.metadata, authToken: 'synthetic-invalid' },
      'accounts.attachNativeCliTerminal',
      {},
      1000,
      undefined,
      undefined,
      { onFrame }
    )
  ).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  expect(f.stream).not.toHaveBeenCalled()
  expect(onFrame).not.toHaveBeenCalled()
})
