import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, readlink, rm } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { afterEach, expect, it, vi } from 'vitest'
import { ensurePinnedEngineAsset } from './engine-asset-cache'
import { readPackagedReplayEngineAsset } from './engine-replay-package'
import { startEngineRuntime, type EngineRuntimeHandle } from './engine-runtime'
import { CodexReplaySpoolBudget } from './codex-replay-spool'
import { createCodexRoutingHttpServer } from './codex-routing-http-server'

const servers: Server[] = []
let directory: string | undefined
let runtime: EngineRuntimeHandle | undefined
const root = process.env.ORCA_PACKAGED_REPLAY_ENGINE_TEST_ROOT
const token = 'synthetic-packaged-parallel-1234567890123456'

async function listen(server: Server): Promise<string> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Synthetic port unavailable')
  }
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (!server.listening) {
      continue
    }
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  if (runtime) {
    const stopped = await runtime.stop()
    if (stopped.root !== 'exited') {
      throw new Error('Synthetic engine exit remains unverifiable')
    }
    runtime = undefined
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

it.skipIf(!root || process.platform !== 'linux')(
  'runs 100 streams through the packaged Go engine, then changes account with exact input history',
  async () => {
    if (!root) {
      throw new Error('Explicit packaged replay engine fixture root required')
    }
    directory = await mkdtemp(join(tmpdir(), 'synthetic-packaged-native-'))
    const held = new Set<ServerResponse>()
    const observed: { account: string; history: string; imageSha256: string }[] = []
    const requestSchema = z.object({
      input: z.array(
        z.object({
          role: z.string(),
          content: z.array(
            z.object({
              type: z.string(),
              text: z.string().optional(),
              image_url: z.string().optional()
            })
          )
        })
      )
    })
    const provider = await listen(
      createServer(async (request, response) => {
        let body = ''
        for await (const chunk of request) {
          body += chunk.toString()
        }
        const payload = requestSchema.parse(JSON.parse(body))
        observed.push({
          account:
            request.headers.authorization === 'Bearer synthetic-A'
              ? 'A'
              : request.headers.authorization === 'Bearer synthetic-B'
                ? 'B'
                : 'unexpected',
          history: payload.input[0].content[0].text ?? '',
          imageSha256: createHash('sha256')
            .update(payload.input[0].content[1].image_url ?? '')
            .digest('hex')
        })
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(
          'data: {"type":"response.created","response":{"id":"synthetic-response","object":"response","status":"in_progress","output":[]}}\n\n'
        )
        response.write(
          'data: {"type":"response.output_text.delta","item_id":"synthetic-message","output_index":0,"content_index":0,"delta":"synthetic"}\n\n'
        )
        held.add(response)
        response.once('close', () => held.delete(response))
      })
    )
    const reserve = createServer()
    const enginePort = Number(new URL(await listen(reserve)).port)
    await new Promise<void>((resolve) => reserve.close(() => resolve()))
    const packaged = await readPackagedReplayEngineAsset(root, 'linux-x64')
    const asset = await ensurePinnedEngineAsset({
      cacheDirectory: join(directory, 'asset'),
      packaged,
      assertExclusiveInstallLease() {},
      assertCanReplaceInstalledBinary() {}
    })
    runtime = await startEngineRuntime({
      directory: join(directory, 'engine'),
      port: enginePort,
      auth: { kind: 'synthetic-test', upstream: provider, accounts: ['A', 'B'] },
      maxRequestBytes: 16 * 1024 * 1024,
      binaryPath: asset.binaryPath,
      expectedSha256: asset.expectedSha256,
      memoryMiB: 128,
      networkProxySettings: null,
      assertExclusiveRuntimeDirectory() {}
    })
    const owner = z
      .object({ group: z.object({ pgid: z.number().int().positive() }) })
      .parse(JSON.parse(await readFile(join(directory, 'engine', 'writer-owner.json'), 'utf8')))
    const readEngineMemory = async () => {
      const status = await readFile(`/proc/${owner.group.pgid}/status`, 'utf8')
      const fds = await readdir(`/proc/${owner.group.pgid}/fd`)
      const targets = await Promise.all(
        fds.map((fd) => readlink(`/proc/${owner.group.pgid}/fd/${fd}`).catch(() => ''))
      )
      return {
        privateSpools: targets.filter((target) => target.includes('cliproxy-native-replay-'))
          .length,
        rssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]),
        highWaterKiB: Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1])
      }
    }
    const before = await readEngineMemory()
    let account = 'synthetic-A'
    const activeRuntime = runtime
    const budget = new CodexReplaySpoolBudget(join(directory, 'spool'), 0, () => {})
    const finished = vi.fn()
    const heldRoute = vi.fn(async () => {})
    const cleanup = vi.fn()
    const front = await listen(
      createCodexRoutingHttpServer({
        maxConcurrent: 1,
        maxRequestBytes: 1024,
        maxResponseBytes: 1024,
        responseHeaderTimeoutMs: 30_000,
        replayBudget: budget,
        onCleanupUnverifiable: cleanup,
        prepare: () => ({
          port: activeRuntime.port,
          clientKey: activeRuntime.clientKey,
          prefix: account,
          finish: finished,
          holdUntilOwnerExit: heldRoute
        })
      })
    )
    const image = `data:image/png;base64,${'A'.repeat(256 * 1024)}`
    const imageSha256 = createHash('sha256').update(image).digest('hex')
    const history = [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'exact retained native history' },
          { type: 'input_image', image_url: image }
        ]
      }
    ]
    const body = JSON.stringify({
      model: 'probe',
      stream: true,
      instructions: 'Synthetic local transport fixture',
      input: history
    })
    const post = (signal?: AbortSignal) =>
      fetch(`${front}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body,
        signal
      })
    const responses = await Promise.all(Array.from({ length: 100 }, () => post()))
    const refused = responses.find((response) => response.status !== 200)
    if (refused) {
      throw new Error(
        `Packaged fixture status=${refused.status} providerRequests=${observed.length} held=${held.size}: ${(await refused.text()).slice(0, 300)}`
      )
    }
    expect(responses.map((response) => response.status)).toEqual(Array(100).fill(200))
    expect(held.size).toBe(100)
    expect(budget.snapshot().active).toBe(100)
    expect(
      observed.every(
        (item) =>
          item.account === 'A' &&
          item.history === history[0].content[0].text &&
          item.imageSha256 === imageSha256
      )
    ).toBe(true)
    const atHundred = await readEngineMemory()
    const complete = () => {
      for (const response of held) {
        response.end(
          'data: {"type":"response.completed","response":{"id":"synthetic-response","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n'
        )
      }
    }
    complete()
    for (const response of responses) {
      expect(await response.text()).toContain('response.completed')
    }
    await vi.waitFor(() => expect(budget.snapshot().active).toBe(0))
    account = 'synthetic-B'
    const next = await post()
    expect(next.status).toBe(200)
    complete()
    expect(await next.text()).toContain('response.completed')
    await vi.waitFor(() => expect(budget.snapshot().active).toBe(0))
    expect(observed[100]).toEqual({
      account: 'B',
      history: history[0].content[0].text,
      imageSha256
    })
    expect(heldRoute).not.toHaveBeenCalled()
    expect(finished).toHaveBeenCalledTimes(101)
    expect(cleanup).not.toHaveBeenCalled()
    expect(await readdir(join(directory, 'spool'))).toEqual([])
    const settledSamples = [await readEngineMemory()]
    for (let round = 0; round < 5; round++) {
      account = round % 2 === 0 ? 'synthetic-A' : 'synthetic-B'
      const batch = await Promise.all(Array.from({ length: 100 }, () => post()))
      expect(batch.every((response) => response.status === 200)).toBe(true)
      expect(held.size).toBe(100)
      const expectedAccount = round % 2 === 0 ? 'A' : 'B'
      expect(
        observed
          .slice(-100)
          .every(
            (item) =>
              item.account === expectedAccount &&
              item.history === history[0].content[0].text &&
              item.imageSha256 === imageSha256
          )
      ).toBe(true)
      complete()
      for (const response of batch) {
        expect(await response.text()).toContain('response.completed')
      }
      await vi.waitFor(() => expect(budget.snapshot().active).toBe(0))
      const settled = await readEngineMemory()
      expect(settled.privateSpools).toBe(0)
      settledSamples.push(settled)
    }
    const after = await readEngineMemory()
    expect(observed).toHaveLength(601)
    expect(Math.max(...settledSamples.map((sample) => sample.rssKiB))).toBeLessThan(384 * 1024)
    expect(after.rssKiB).toBeLessThan(settledSamples[0].rssKiB + 64 * 1024)
    expect(before.privateSpools).toBe(0)
    expect(atHundred.privateSpools).toBe(100)
    expect(after.privateSpools).toBe(0)
    console.info(
      'native-packaged-parallel-resources',
      JSON.stringify({
        binarySha256: asset.expectedSha256,
        before,
        atHundred,
        after,
        settledSamples,
        spool: budget.snapshot()
      })
    )
  },
  120_000
)
