import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { engineHostFixture, syntheticTurn } from './codex-engine-host-fixture'
import { engineCredentialFilename } from './engine-account-connection'
import { reserveEngineWriter } from './engine-writer-ownership'

const fixtures: ReturnType<typeof engineHostFixture>[] = []
function fixture() {
  const f = engineHostFixture()
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.cleanup()
  }
})
it('retires a closed session grant only after verified writer stop and direct native commit', async () => {
  const f = fixture(),
    launch = await f.launch()
  await syntheticTurn(launch)
  launch.close('exited')
  const commit = vi.fn(async () => {
    expect(f.stats.residents).toBe(0)
    f.accounts.delete(f.a.id)
    return 'removed'
  })
  expect(await f.host.removeNativeAccount(f.a.id, commit)).toBe('removed')
  expect(commit).toHaveBeenCalledTimes(1)
  expect(existsSync(join(f.directory, 'active-auth', engineCredentialFilename(f.a.id)))).toBe(false)
  expect(f.host.readConnection(f.b.id)?.adopted).toBe(true)
  expect((await syntheticTurn(launch)).status).not.toBe(200)
})
it('preserves native account and grant when the engine writer cannot prove exit', async () => {
  const f = fixture()
  const launch = await f.launch()
  launch.close('exited')
  f.stats.stopVerdict = 'unverifiable'
  const commit = vi.fn(async () => {})
  await expect(f.host.removeNativeAccount(f.a.id, commit)).rejects.toThrow()
  expect(commit).not.toHaveBeenCalled()
  expect(f.host.readConnection(f.a.id)).not.toBeNull()
  f.stats.stopVerdict = 'exited'
})
it('does not download or start an engine for cold native account removal', async () => {
  const f = fixture()
  await f.host.removeNativeAccount(f.a.id, async () => {
    f.accounts.delete(f.a.id)
  })
  expect(f.stats.starts).toBe(0)
  expect(f.stats.provisions).toBe(0)
})
it('refuses cold retirement when a prior writer spawn window remains unknown', async () => {
  const f = fixture()
  const writer = reserveEngineWriter({
    directory: join(f.directory, 'runtime'),
    assertExclusive: () => {}
  })
  const commit = vi.fn(async () => {})
  try {
    await expect(f.host.removeNativeAccount(f.a.id, commit)).rejects.toThrow()
    expect(commit).not.toHaveBeenCalled()
  } finally {
    writer.cancelBeforeSpawn()
  }
})

it('preserves a live conversation when deleting its newly routed B account would break the shared history dialog', async () => {
  const f = fixture(),
    launch = await f.launch()
  await syntheticTurn(launch)
  if (!f.state.policy) {
    throw new Error('Missing synthetic policy')
  }
  f.state.policy.revision++
  f.state.policy.members[0].state = 'disabled'
  await syntheticTurn(launch, '2')
  expect(f.db.listAccountPoolAssignments()[0].accountId).toBe(f.b.id)
  const commit = vi.fn(async () => {})
  const before = f.host.readConnection(f.b.id)
  await expect(f.host.removeNativeAccount(f.b.id, commit)).rejects.toThrow(/native CLI still uses/)
  expect(commit).not.toHaveBeenCalled()
  expect(f.host.readConnection(f.b.id)).toEqual(before)
  expect((await syntheticTurn(launch, '2')).status).toBe(200)
  expect(f.stats.starts).toBe(1)
})

it('refuses deletion while an accepted request survives uncertain native contact', async () => {
  const f = fixture(),
    launch = await f.launch()
  f.stats.holdResponse = true
  const pending = syntheticTurn(launch).catch(() => null)
  await expect.poll(() => f.stats.models.length).toBe(1)
  launch.close('unverifiable')
  const commit = vi.fn(async () => {})
  await expect(f.host.removeNativeAccount(f.a.id, commit)).rejects.toThrow(/native CLI still uses/)
  expect(commit).not.toHaveBeenCalled()
  expect(f.host.readConnection(f.a.id)?.adopted).toBe(true)
  launch.close('exited')
  await launch.revoke()
  await pending
})

it('keeps an aborted provider lease until the execution host proves exit', async () => {
  const f = fixture()
  const launch = await f.launch()
  f.stats.holdResponse = true
  f.stats.stopVerdict = 'unverifiable'
  const controller = new AbortController()
  const pending = fetch(`${launch.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${launch.apiKey}`,
      'content-type': 'application/json',
      'x-codex-turn-metadata': JSON.stringify({ thread_id: 'synthetic-thread', turn_id: '1' })
    },
    body: '{"model":"native-model"}',
    signal: controller.signal
  }).catch(() => null)
  await expect.poll(() => f.stats.models.length).toBe(1)
  const held = f.db.listAccountPoolAssignments()
  expect(held).toHaveLength(1)
  controller.abort()
  await pending
  await expect.poll(() => f.stats.stopAttempts).toBe(1)
  expect(f.host.readConnection(f.a.id)).not.toBeNull()
  expect(f.db.listAccountPoolAssignments()).toEqual(held)
  f.stats.stopVerdict = 'exited'
  await f.host.stop()
  await expect.poll(() => f.db.listAccountPoolAssignments()).toEqual([])
})
