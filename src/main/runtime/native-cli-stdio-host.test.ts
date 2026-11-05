import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  startNativeCliStdio,
  requireNativeCliStdioSession,
  stopNativeCliStdioSessions,
  markNativeCliStdioControlFailure
} from './native-cli-stdio-host'
import { readNativeCliStdioOwner } from './native-cli-stdio-owner'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('./native-cli-account-launch', () => ({
  prepareNativeCliAccountLaunch: async () => ({
    env: { CLAUDE_CONFIG_DIR: join(state.root, 'home') },
    envToDelete: []
  }),
  releaseNativeCliAccountLaunch: async () => {}
}))
vi.mock('./runtime-claude-native-sources', () => ({
  getRuntimeClaudeNativeLaunchContext: () => ({ dataRoot: state.root, assertExclusive() {} })
}))
vi.mock('./native-claude-routing-ownership', () => ({
  releaseNativeClaudeRoutingOwner: async () => false
}))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  closeTestJournalHostDatabases()
  if (state.root) {
    await rm(state.root, { recursive: true, force: true })
  }
})
async function runtimeFixture() {
  state.root = await mkdtemp(join(tmpdir(), 'opka-stdio-host-'))
  const store = await openTestAgentSessionRecordStore(state.root)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Account routing is mocked; these are the complete runtime members this actual-process transport uses.
  const runtime = {
    openAgentSessionRecordStore: async () => store,
    getNativeCliAgentSessionClaimKeyId: () => 'test-host-key-id',
    getRuntimeId: () => 'test-runtime',
    openedOrchestrationDb: () => null
  } as unknown as OrcaRuntimeService
  cleanups.push(() => stopNativeCliStdioSessions(runtime))
  return { runtime, store }
}
async function fixture(code: string) {
  const { runtime, store } = await runtimeFixture()
  const result = await startNativeCliStdio(runtime, {
    launchId: randomUUID(),
    executable: process.execPath,
    args: ['-e', code],
    cwd: state.root,
    env: {}
  })
  const session = requireNativeCliStdioSession(runtime, result.launchId, result.generation)
  return { runtime, store, result, session }
}
it('proves the actual native PID and preserves binary input, output channels, EOF and native exit', async () => {
  const f = await fixture(
    `const parts=[];process.stdin.on('data',b=>parts.push(b));process.stdin.on('end',()=>{process.stdout.write(Buffer.concat(parts));process.stderr.write(Buffer.from([255,0,128]));process.exitCode=7})`
  )
  expect(readNativeCliStdioOwner(f.runtime, f.result.launchId)?.process.pid).toBe(
    f.session.group?.pgid
  )
  const stdout: Buffer[] = [],
    stderr: Buffer[] = []
  let exit: number | undefined
  let sequence = 0
  const detach = f.session.output.attach((frame) => {
    if (frame.type === 'native-stdio-exit') {
      exit = frame.code
      return
    }
    sequence = frame.sequence
    ;(frame.channel === 'stdout' ? stdout : stderr).push(Buffer.from(frame.bytes, 'base64'))
    f.session.output.acknowledge(sequence)
  })
  f.session.attached = true
  const input = Buffer.alloc(64 * 1024, 197)
  for (let offset = 0; offset < input.length; offset += 32 * 1024) {
    await f.session.control({
      ...f.result,
      sequence,
      inputSequence: offset / (32 * 1024) + 1,
      input: input.subarray(offset, offset + 32 * 1024).toString('base64')
    })
  }
  await f.session.control({ ...f.result, sequence, inputSequence: 3, eof: true })
  await f.session.done
  expect(Buffer.concat(stdout)).toEqual(input)
  expect(Buffer.concat(stderr)).toEqual(Buffer.from([255, 0, 128]))
  expect(exit).toBe(7)
  expect(f.store.listRecords()).toHaveLength(0)
  expect(readNativeCliStdioOwner(f.runtime, f.result.launchId)).toBeNull()
  detach()
}, 15_000)

it('fails the wrapper on model-entry control failure without filtering native bytes or duplicating diagnostics', async () => {
  const f = await fixture(
    `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('{"native":"unchanged"}'))`
  )
  const stdout: Buffer[] = [],
    stderr: Buffer[] = []
  let sequence = 0,
    exit: number | undefined
  markNativeCliStdioControlFailure(f.runtime, f.result.launchId)
  markNativeCliStdioControlFailure(f.runtime, f.result.launchId)
  const detach = f.session.output.attach((frame) => {
    if (frame.type === 'native-stdio-exit') {
      exit = frame.code
      return
    }
    sequence = frame.sequence
    ;(frame.channel === 'stdout' ? stdout : stderr).push(Buffer.from(frame.bytes, 'base64'))
    f.session.output.acknowledge(sequence)
  })
  f.session.attached = true
  await f.session.control({ ...f.result, sequence, inputSequence: 1, eof: true })
  await f.session.done
  expect(Buffer.concat(stdout).toString()).toBe('{"native":"unchanged"}')
  expect(Buffer.concat(stderr).toString()).toBe(
    'Opka could not verify native account control; this command did not complete successfully.\n'
  )
  expect(exit).toBe(1)
  expect(f.store.listRecords()).toHaveLength(0)
  detach()
}, 15_000)

it('pre-aborted start creates no process, lease or retained launch', async () => {
  const { runtime, store } = await runtimeFixture()
  const launchId = randomUUID()
  const controller = new AbortController()
  controller.abort()
  await expect(
    startNativeCliStdio(
      runtime,
      {
        launchId,
        executable: process.execPath,
        args: ['-e', "require('fs').writeFileSync('unexpected-spawn','bad')"],
        cwd: state.root,
        env: {}
      },
      controller.signal
    )
  ).rejects.toThrow()
  expect(store.listRecords()).toHaveLength(0)
  expect(readNativeCliStdioOwner(runtime, launchId)).toBeNull()
  expect(() => requireNativeCliStdioSession(runtime, launchId, randomUUID())).toThrow()
  const { access } = await import('node:fs/promises')
  await expect(access(join(state.root, 'unexpected-spawn'))).rejects.toThrow()
})
it('retains early final output and exact exit until a later attachment', async () => {
  const f = await fixture("process.stdout.write('final-bytes');process.exitCode=19")
  await f.session.managed?.exitPromise
  await vi.waitFor(() => expect(f.store.listRecords()).toHaveLength(0))
  const frames: string[] = []
  let code: number | undefined
  f.session.attached = true
  f.session.output.attach((frame) => {
    if (frame.type === 'native-stdio-exit') {
      code = frame.code
      return
    }
    frames.push(Buffer.from(frame.bytes, 'base64').toString())
    f.session.output.acknowledge(frame.sequence)
  })
  await f.session.done
  expect(frames.join('')).toBe('final-bytes')
  expect(code).toBe(19)
  expect(readNativeCliStdioOwner(f.runtime, f.result.launchId)).toBeNull()
}, 15_000)
it('closes and retires the actual process after an attachment emitter fails', async () => {
  const f = await fixture(
    "process.stdin.once('data',()=>setInterval(()=>process.stdout.write('bounded'),20))"
  )
  f.session.attached = true
  f.session.output.attach(() => {
    throw new Error('fixture disconnected')
  })
  await f.session.control({
    ...f.result,
    sequence: 0,
    inputSequence: 1,
    input: Buffer.from('go').toString('base64')
  })
  await f.session.done
  await vi.waitFor(() => expect(f.store.listRecords()).toHaveLength(0), { timeout: 10_000 })
  expect(await f.session.close()).toBe(true)
  expect(readNativeCliStdioOwner(f.runtime, f.result.launchId)).toBeNull()
}, 15_000)
it('rejects duplicate launch and stale generation without replacing the live owner', async () => {
  const f = await fixture('process.stdin.resume()')
  const owner = readNativeCliStdioOwner(f.runtime, f.result.launchId)
  await expect(
    startNativeCliStdio(f.runtime, {
      launchId: f.result.launchId,
      executable: process.execPath,
      args: ['-e', "throw new Error('duplicate must not spawn')"],
      cwd: state.root,
      env: {}
    })
  ).rejects.toThrow()
  expect(() => requireNativeCliStdioSession(f.runtime, f.result.launchId, randomUUID())).toThrow()
  await expect(
    f.session.control({
      ...f.result,
      generation: randomUUID(),
      sequence: 0,
      inputSequence: 1,
      eof: true
    })
  ).rejects.toThrow()
  expect(readNativeCliStdioOwner(f.runtime, f.result.launchId)).toEqual(owner)
  expect(f.store.listRecords()).toHaveLength(1)
  expect(await f.session.close()).toBe(true)
}, 15_000)
