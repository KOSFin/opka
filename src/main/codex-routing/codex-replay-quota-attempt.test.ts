import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createCodexRoutingHttpServer } from './codex-routing-http-server'
import { CodexReplaySpoolBudget } from './codex-replay-spool'

const servers: Server[] = []
const directories: string[] = []
async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Synthetic listener unavailable')
  }
  return address.port
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

it('does not transfer prior quota terminal proof to a later local error with a held provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-quota-attempt-'))
  directories.push(directory)
  const replayBudget = new CodexReplaySpoolBudget(directory, 512 * 1024 * 1024, () => {})
  let providerSeen = () => {}
  const seen = new Promise<void>((resolve) => {
    providerSeen = resolve
  })
  const providerPort = await listen(createServer((_req, _res) => providerSeen()))
  let held: ReturnType<typeof request> | undefined
  let engineCalls = 0
  const enginePort = await listen(
    createServer(async (incoming, outgoing) => {
      incoming.resume()
      await once(incoming, 'end')
      engineCalls++
      if (engineCalls === 1) {
        outgoing.writeHead(429, {
          'content-type': 'application/json',
          trailer: 'X-Orca-Provider-Terminal-V1'
        })
        outgoing.addTrailers({ 'X-Orca-Provider-Terminal-V1': '1' })
        outgoing.end('{"error":{"code":"usage_limit_reached"}}')
        return
      }
      held = request({ host: '127.0.0.1', port: providerPort, method: 'POST' })
      held.on('error', () => {})
      held.end()
      await seen
      outgoing.writeHead(500, { 'content-type': 'application/json' })
      outgoing.end('{"error":"local engine failure with provider still live"}')
    })
  )
  let ownerExited = () => {}
  const exited = new Promise<void>((resolve) => {
    ownerExited = resolve
  })
  const finish = vi.fn()
  const cleanup = vi.fn()
  const onRequestHeld = vi.fn()
  const retry = vi.fn(async () => ({
    port: enginePort,
    clientKey: 'synthetic-engine-key-1234567890123456',
    prefix: 'b',
    quotaIdentity: 'b',
    accountId: 'b',
    finish,
    holdUntilOwnerExit: () => exited
  }))
  const frontPort = await listen(
    createCodexRoutingHttpServer({
      maxConcurrent: 4,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      responseHeaderTimeoutMs: 1000,
      replayBudget,
      onCleanupUnverifiable: cleanup,
      onRequestHeld,
      prepare: () => ({
        port: enginePort,
        clientKey: 'synthetic-engine-key-1234567890123456',
        prefix: 'a',
        quotaIdentity: 'a',
        accountId: 'a',
        finish,
        holdUntilOwnerExit: () => exited,
        retryRejectedQuota: retry
      })
    })
  )
  const response = await fetch(`http://127.0.0.1:${frontPort}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${'s'.repeat(64)}` },
    body: '{"model":"native","stream":true,"input":[]}'
  })
  expect(response.status).toBe(500)
  await response.text()
  await vi.waitFor(() => expect(onRequestHeld).toHaveBeenCalledOnce())
  expect(cleanup).not.toHaveBeenCalled()
  expect(retry).toHaveBeenCalledOnce()
  expect(engineCalls).toBe(2)
  expect(held?.destroyed).toBe(false)
  expect(finish).not.toHaveBeenCalled()
  expect(replayBudget.snapshot().active).toBe(1)
  held?.destroy()
  ownerExited()
  await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce())
  expect(replayBudget.snapshot()).toEqual({ active: 0, large: 0, reservedBytes: 0 })
  expect(await readdir(directory)).toEqual([])
  expect(cleanup).not.toHaveBeenCalled()
})
