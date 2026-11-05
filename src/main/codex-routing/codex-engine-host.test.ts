import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CodexEngineHost } from './codex-engine-host'
import { engineHostFixture, syntheticTurn, tick } from './codex-engine-host-fixture'
import { engineCredentialFilename } from './engine-account-connection'
import { reserveEngineWriter } from './engine-writer-ownership'

const fixtures: ReturnType<typeof engineHostFixture>[] = []
const fixture = (timeout?: number) => {
  const f = engineHostFixture(timeout)
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.cleanup()
  }
})

it('owns one engine/cache/front for concurrent launches and routes saved policy at native boundaries', async () => {
  const f = fixture()
  const [first, second] = await Promise.all([f.launch('first'), f.launch('second')])
  expect(new URL(first.baseUrl).origin).toBe(new URL(second.baseUrl).origin)
  expect(first.baseUrl).not.toBe(second.baseUrl)
  expect(first.apiKey).toBe(second.apiKey)
  expect(f.stats).toMatchObject({ starts: 1, provisions: 1, maximum: 1 })
  expect((await syntheticTurn(first, '1')).status).toBe(200)
  if (!f.state.policy) {
    throw new Error('Missing fixture policy')
  }
  f.state.policy.revision++
  f.state.policy.members[0].state = 'disabled'
  expect((await syntheticTurn(first, '1')).status).toBe(200)
  expect((await syntheticTurn(first, '2')).status).toBe(200)
  expect(f.stats.models.map((model) => model.split('/')[0])).toEqual([
    f.host.readConnection(f.a.id)?.prefix,
    f.host.readConnection(f.a.id)?.prefix,
    f.host.readConnection(f.b.id)?.prefix
  ])
  expect(f.db.listAccountPoolAssignments()).toHaveLength(1)
  expect(f.stats.bindings.map((binding) => binding.accountId)).toEqual([f.a.id, f.a.id, f.b.id])
  expect(f.stats.bindings[2].assignmentOwnerKey).toBe(f.db.listAccountPoolAssignments()[0].ownerKey)
})

it('keeps manual native-default fallback native and does not provision an engine', async () => {
  const f = fixture()
  f.state.policy = undefined
  f.state.manualAccountId = null
  expect(
    await f.host.prepareNativeLaunch({
      launchId: 'default',
      ownerPrefix: 'default',
      canSwitch: () => true
    })
  ).toBeNull()
  expect(f.stats.starts).toBe(0)
  expect(f.stats.provisions).toBe(0)
})

it('passes the canonical captured native boundary permit through and acknowledges only a new root', async () => {
  const f = fixture()
  let accepted = 0
  const launch = await f.launch('permit', () => ({
    canSwitch: () => true,
    onBoundaryAccepted: () => {
      accepted++
    }
  }))
  await syntheticTurn(launch, '1')
  await syntheticTurn(launch, '1')
  expect(accepted).toBe(0)
  await syntheticTurn(launch, '2')
  expect(accepted).toBe(1)
})

it('does not admit a request with an unknown local capability', async () => {
  const f = fixture()
  const launch = await f.launch()
  const response = await syntheticTurn({ ...launch, apiKey: 'unknown-local-capability'.repeat(3) })
  expect(response.status).toBe(401)
  expect(f.stats.models).toEqual([])
})

it('rejects a second controller for the same host profile', () => {
  const f = fixture()
  expect(() => new CodexEngineHost(f.options)).toThrow(/already.*owner/)
})

it('requires every prefix to be adopted before returning native launch transport', async () => {
  const f = fixture(60)
  f.stats.omitPrefix = true
  await expect(f.launch()).rejects.toThrow()
  expect(f.host.readConnection(f.a.id)?.adopted).toBe(false)
  expect(f.host.readConnection(f.b.id)?.adopted).toBe(false)
  expect(f.stats.models).toEqual([])
})

it('retains process ownership after startup fails and excludes it before a later start', async () => {
  const f = fixture()
  f.stats.failAfterSpawn = true
  await expect(f.launch()).rejects.toThrow(/readiness/)
  f.stats.failAfterSpawn = false
  await f.launch()
  expect(f.stats).toMatchObject({ starts: 2, residents: 1, maximum: 1 })
})

it('rechecks the existing roster revision inside its mutation serializer', async () => {
  const f = fixture()
  await f.launch()
  f.options.withAccountMutationLease = async (operation) => {
    f.accounts.set(f.a.id, { ...f.a, rosterRevision: 'native-reauth-r2' })
    return operation()
  }
  const state = await f.host.beginGrant('owner', {
    accountId: f.a.id,
    expectedRosterRevision: 'r1'
  })
  await tick()
  f.finishLogin()
  await expect.poll(() => f.host.grant('owner', state.id).status).toBe('failed')
  expect(f.stats.starts).toBe(1)
  expect(
    readFileSync(join(f.directory, 'active-auth', engineCredentialFilename(f.a.id)), 'utf8')
  ).not.toContain('synthetic-new')
})

it('only completes consent after draining native work, excluding the old writer and adopting all prefixes', async () => {
  const f = fixture()
  const launch = await f.launch()
  f.stats.safe = false
  const state = await f.host.beginGrant('owner', {
    accountId: f.a.id,
    expectedRosterRevision: 'r1'
  })
  await tick()
  f.finishLogin()
  await tick()
  expect(f.host.grantPhase('owner', state.id)).toBe('activation')
  expect(f.host.grant('owner', state.id)).not.toHaveProperty('userCode')
  expect((await syntheticTurn(launch)).status).toBe(502)
  expect(f.stats.starts).toBe(1)
  f.stats.safe = true
  launch.notifyBoundaryChanged()
  await expect.poll(() => f.host.grant('owner', state.id).status).toBe('complete')
  expect(f.stats).toMatchObject({ starts: 2, maximum: 1 })
  expect(f.host.readConnection(f.a.id)?.adopted).toBe(true)
  expect(f.host.readConnection(f.b.id)?.adopted).toBe(true)
  expect(
    readFileSync(join(f.directory, 'active-auth', engineCredentialFilename(f.a.id)), 'utf8')
  ).toContain('synthetic-new')
})

it('cancellation releases a pending activation without replacing the valid connection', async () => {
  const f = fixture()
  const launch = await f.launch()
  f.stats.safe = false
  const state = await f.host.beginGrant('owner', {
    accountId: f.a.id,
    expectedRosterRevision: 'r1'
  })
  await tick()
  f.finishLogin()
  await tick()
  f.host.cancelGrant('owner', state.id)
  await tick()
  expect(f.host.grant('owner', state.id).status).toBe('cancelled')
  expect(f.stats.starts).toBe(1)
  expect(f.host.readConnection(f.a.id)?.adopted).toBe(true)
  f.stats.safe = true
  launch.notifyBoundaryChanged()
  expect((await syntheticTurn(launch)).status).toBe(200)
})

it('bounds a missing native boundary and preserves the old writer/grant', async () => {
  const f = fixture(40)
  await f.launch()
  f.stats.safe = false
  const state = await f.host.beginGrant('owner', {
    accountId: f.a.id,
    expectedRosterRevision: 'r1'
  })
  await tick()
  f.finishLogin()
  await expect.poll(() => f.host.grant('owner', state.id).status).toBe('failed')
  expect(f.stats.starts).toBe(1)
  expect(f.host.readConnection(f.a.id)?.adopted).toBe(true)
})

it('bounds cancellation behind another native account mutation and never publishes its late callback', async () => {
  const f = fixture(40)
  const launch = await f.launch()
  let unblock = () => {}
  const previousMutation = new Promise<void>((resolve) => {
    unblock = resolve
  })
  f.options.withAccountMutationLease = async (operation) => {
    await previousMutation
    return operation()
  }
  const state = await f.host.beginGrant('owner', {
    accountId: f.a.id,
    expectedRosterRevision: 'r1'
  })
  await tick()
  f.finishLogin()
  await expect.poll(() => f.host.grant('owner', state.id).status).toBe('failed')
  expect((await syntheticTurn(launch)).status).toBe(200)
  unblock()
  await tick()
  expect(f.stats.starts).toBe(1)
  expect(
    readFileSync(join(f.directory, 'active-auth', engineCredentialFilename(f.a.id)), 'utf8')
  ).not.toContain('synthetic-new')
})

it('fails closed without starting a replacement when writer exit is unverifiable', async () => {
  const f = fixture()
  await f.launch()
  f.stats.stopVerdict = 'unverifiable'
  const state = await f.host.beginGrant('owner', {
    accountId: f.a.id,
    expectedRosterRevision: 'r1'
  })
  await tick()
  f.finishLogin()
  await expect.poll(() => f.host.grant('owner', state.id).status).toBe('failed')
  expect(f.stats.starts).toBe(1)
  expect(f.host.readConnection(f.a.id)?.adopted).toBe(false)
  expect(f.stats.maximum).toBe(1)
})

it('removes only a deleted accounts exact grant after draining and keeps another account adopted', async () => {
  const f = fixture()
  const launch = await f.launch()
  f.stats.safe = false
  f.accounts.delete(f.a.id)
  const removal = f.host.retireDeletedAccount(f.a.id)
  await tick()
  const deleted = join(f.directory, 'active-auth', engineCredentialFilename(f.a.id))
  expect(existsSync(deleted)).toBe(true)
  f.stats.safe = true
  launch.notifyBoundaryChanged()
  await removal
  expect(existsSync(deleted)).toBe(false)
  expect(existsSync(join(f.directory, 'connections', f.a.id))).toBe(false)
  expect(f.host.readConnection(f.b.id)?.adopted).toBe(true)
  expect(f.stats).toMatchObject({ starts: 2, maximum: 1 })
})

it('never converts a closed but unverifiable native owner into a safe activation boundary', async () => {
  const f = fixture(40)
  const launch = await f.launch()
  launch.close('unverifiable')
  f.accounts.delete(f.a.id)
  await expect(f.host.retireDeletedAccount(f.a.id)).rejects.toThrow()
  expect(existsSync(join(f.directory, 'active-auth', engineCredentialFilename(f.a.id)))).toBe(true)
  expect(f.stats.starts).toBe(1)
  launch.close('exited')
  await f.host.retireDeletedAccount(f.a.id)
  expect(f.host.readConnection(f.b.id)?.adopted).toBe(true)
})

it('refuses cold publication and deletion while a prior writer has an unknown spawn window', async () => {
  const f = fixture()
  const writer = reserveEngineWriter({
    directory: join(f.directory, 'runtime'),
    assertExclusive: () => {}
  })
  const pending = await f.host.beginGrant('owner', {
    accountId: f.a.id,
    expectedRosterRevision: 'r1'
  })
  await expect.poll(() => f.host.grant('owner', pending.id).status).toBe('failed')
  expect(f.stats.starts).toBe(0)
  const file = join(f.directory, 'active-auth', engineCredentialFilename(f.a.id))
  expect(readFileSync(file, 'utf8')).not.toContain('synthetic-new')
  f.accounts.delete(f.a.id)
  await expect(f.host.retireDeletedAccount(f.a.id)).rejects.toThrow(/writer|host/)
  expect(existsSync(file)).toBe(true)
  // This fixture knows it never spawned; a recovered execution host cannot make that assertion.
  writer.cancelBeforeSpawn()
})
