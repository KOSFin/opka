import { afterEach, expect, it } from 'vitest'
import { CodexEngineHost } from './codex-engine-host'
import { engineHostFixture, syntheticTurn } from './codex-engine-host-fixture'

const fixtures: ReturnType<typeof engineHostFixture>[] = []
const fixture = () => {
  const f = engineHostFixture()
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.cleanup()
  }
})

it('revokes capability but holds the accepted lease until writer exit is proven', async () => {
  const f = fixture()
  const launch = await f.launch()
  f.stats.holdResponse = true
  f.stats.safe = false
  f.stats.stopVerdict = 'unverifiable'
  const pending = syntheticTurn(launch).catch(() => null)
  await expect.poll(() => f.stats.models.length).toBe(1)
  expect(f.db.listAccountPoolAssignments()).toHaveLength(1)
  const revoking = launch.revoke()
  await pending
  await expect.poll(() => f.stats.stopAttempts).toBe(1)
  expect(f.db.listAccountPoolAssignments()).toHaveLength(1)
  expect(f.stats).toMatchObject({ safe: false, residents: 1 })
  expect((await syntheticTurn(launch)).status).toBe(502)
  f.stats.stopVerdict = 'exited'
  await f.host.stop()
  await revoking
  expect(f.db.listAccountPoolAssignments()).toHaveLength(0)
  expect(f.stats.residents).toBe(0)
})

it('reclaims bounded capability slots after explicit revocation while keeping one engine', async () => {
  const f = fixture()
  for (let index = 0; index < 65; index++) {
    const launch = await f.launch()
    await launch.revoke()
  }
  expect(f.stats).toMatchObject({ starts: 1, maximum: 1 })
})

it('shutdown revokes leases only after writer proof and does not wait for native tools', async () => {
  const f = fixture()
  const launch = await f.launch()
  expect((await syntheticTurn(launch)).status).toBe(200)
  f.stats.safe = false
  await f.host.beginShutdown()
  expect(f.db.listAccountPoolAssignments()).toHaveLength(1)
  f.stats.stopVerdict = 'unverifiable'
  await expect(f.host.stop()).rejects.toThrow(/writer/)
  expect(f.db.listAccountPoolAssignments()).toHaveLength(1)
  f.stats.stopVerdict = 'exited'
  await f.host.stop()
  expect(f.stats).toMatchObject({ residents: 0, safe: false })
  expect(f.db.listAccountPoolAssignments()).toHaveLength(0)
  const next = new CodexEngineHost(f.options)
  await f.host.stop()
  expect(() => new CodexEngineHost(f.options)).toThrow(/already.*owner/)
  await next.stop()
})
