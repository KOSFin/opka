import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountPoolPolicySchema } from '../../shared/account-pool-policy'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import { OrcaRuntimeService } from './orca-runtime'

class ExitRuntime extends OrcaRuntimeService {
  register(incarnationId: string, connectionId: string | null = null) {
    const pty = this.recordPtyWorktree('pty-recovered', 'synthetic-workspace', { connected: true })
    pty.incarnationId = incarnationId
    pty.connectionId = connectionId
    return pty
  }
}
const roots: string[] = []
const databases: OrchestrationDb[] = []
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'opka-pool-exit-'))
  roots.push(root)
  const file = join(root, 'pool.db')
  const original = new OrchestrationDb(file)
  original.acquireAccountPoolAssignment({
    ownerKey: 'synthetic-owner',
    policy: AccountPoolPolicySchema.parse({
      id: 'pool',
      provider: 'codex',
      revision: 1,
      strategy: 'balanced',
      unknownQuota: 'allow',
      allowReserve: false,
      members: [{ accountId: 'a', priority: 1, weight: 1, state: 'enabled', role: 'primary' }]
    }),
    candidates: [
      {
        accountId: 'a',
        quotaIdentity: 'quota-a',
        auth: 'ready',
        quota: 'unknown',
        usedPercent: null
      }
    ]
  })
  original.bindAccountPoolAssignmentPty({
    ownerKey: 'synthetic-owner',
    ptyId: 'pty-recovered',
    incarnationId: 'generation-a'
  })
  original.close()
  const recovered = new OrchestrationDb(file)
  databases.push(recovered)
  const runtime = new ExitRuntime()
  vi.spyOn(runtime, 'getExistingOrchestrationDb').mockReturnValue(recovered)
  return { runtime, recovered }
}
it('releases the durable binding after runtime restart without an exit subscriber', async () => {
  const f = fixture()
  f.runtime.register('generation-a')
  await f.runtime.onPtyExit('pty-recovered', 0, 'generation-a', { providerExitObserved: true })
  expect(f.recovered.listAccountPoolAssignments()).toEqual([])
})
it.each([undefined, 'generation-old'])(
  'retains a lease when exit generation is %s',
  async (generation) => {
    const f = fixture()
    f.runtime.register('generation-a')
    await f.runtime.onPtyExit('pty-recovered', 0, generation, { providerExitObserved: true })
    expect(f.recovered.listAccountPoolAssignments()).toHaveLength(1)
  }
)
it('retains owning-host capacity when a client receives a mirrored SSH exit', async () => {
  const f = fixture()
  f.runtime.register('generation-a', 'ssh-foreign')
  await f.runtime.onPtyExit('pty-recovered', 0, 'generation-a', { hostExitConfirmed: true })
  expect(f.recovered.listAccountPoolAssignments()).toHaveLength(1)
})
it('does not treat a disconnected provider as physical exit', async () => {
  const f = fixture()
  f.runtime.register('generation-a')
  await f.runtime.onPtyExit('pty-recovered', -1, 'generation-a')
  expect(f.recovered.listAccountPoolAssignments()).toHaveLength(1)
})
it('releases only exact persisted generation rows', () => {
  const f = fixture()
  f.recovered.releaseAccountPoolPtyGeneration('pty-recovered', undefined)
  f.recovered.releaseAccountPoolPtyGeneration('pty-recovered', 'generation-old')
  expect(f.recovered.listAccountPoolAssignments()).toHaveLength(1)
  f.recovered.releaseAccountPoolPtyGeneration('pty-recovered', 'generation-a')
  expect(f.recovered.listAccountPoolAssignments()).toEqual([])
})
