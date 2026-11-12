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

it('withholds a complete compact artifact when the provider remains live without terminal proof', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-compact-terminal-'))
  directories.push(directory)
  const replayBudget = new CodexReplaySpoolBudget(directory, 512 * 1024 * 1024, () => {})
  let providerSeen = () => {}
  const seen = new Promise<void>((resolve) => {
    providerSeen = resolve
  })
  const providerPort = await listen(createServer((_req, _res) => providerSeen()))
  let held: ReturnType<typeof request> | undefined
  const enginePort = await listen(
    createServer(async (incoming, outgoing) => {
      incoming.resume()
      await once(incoming, 'end')
      held = request({ host: '127.0.0.1', port: providerPort, method: 'POST' })
      held.on('error', () => {})
      held.end()
      await seen
      outgoing.writeHead(200, { 'content-type': 'application/json' })
      outgoing.end('{"output":[{"type":"compaction","encrypted_content":"synthetic"}]}')
    })
  )
  let ownerExited = () => {}
  const exited = new Promise<void>((resolve) => {
    ownerExited = resolve
  })
  const cleanup = vi.fn()
  const onRequestHeld = vi.fn()
  const finish = vi.fn()
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
        finish,
        holdUntilOwnerExit: () => exited
      })
    })
  )
  const response = await fetch(`http://127.0.0.1:${frontPort}/v1/responses/compact`, {
    method: 'POST',
    headers: { authorization: `Bearer ${'s'.repeat(64)}` },
    body: '{"model":"native","input":[]}'
  })
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain('encrypted_content')
  await vi.waitFor(() => expect(onRequestHeld).toHaveBeenCalledOnce())
  expect(cleanup).not.toHaveBeenCalled()
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
