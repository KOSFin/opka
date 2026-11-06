import { removeEngineGrantConnection } from '../codex-routing/engine-grant-files'
import { realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  nativeRoutingFixture,
  nativePlanTurn,
  nativeLaunchId,
  nestedLaunchId,
  parentProof,
  nativeRoutingHooks
} from './native-codex-routing-launch-fixture'
import {
  prepareNativeCliAccountLaunch,
  releaseNativeCliAccountLaunch
} from './native-cli-account-launch'
import { prepareNativeCodexRoutingLaunch } from './native-codex-routing-launch'
import { preparePtyAccountPoolLaunch } from '../ipc/pty/account-pool-launch'
import { NATIVE_CLI_INITIAL_ASSIGNMENT_ENV } from '../../shared/native-cli-account-launch'

const routingHooks = nativeRoutingHooks()
const fixtures: Awaited<ReturnType<typeof nativeRoutingFixture>>[] = []
async function fixture() {
  const f = await nativeRoutingFixture()
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.cleanup()
  }
})
const request = {
  provider: 'codex' as const,
  codexExecutable: process.execPath,
  launchId: nativeLaunchId,
  parentTerminal: parentProof
}

it('wires the real launch→host→DB→HTTP path without initial double admission or native profile changes', async () => {
  const f = await fixture()
  f.plans.add(nativeLaunchId)
  const plan = await prepareNativeCliAccountLaunch(f.runtime, request)
  expect(plan).toMatchObject({
    accountId: null,
    poolId: 'existing-roster',
    env: { CODEX_HOME: realpathSync(f.home) }
  })
  expect(plan.envToDelete).toEqual(
    expect.arrayContaining(['CODEX_ACCESS_TOKEN', 'CODEX_SQLITE_HOME'])
  )
  expect(f.db.listAccountPoolAssignments()).toEqual([])
  expect((await nativePlanTurn(plan)).status).toBe(200)
  const assignment = f.db.listAccountPoolAssignments()[0]
  expect(assignment).toMatchObject({
    accountId: f.a.id,
    ptyId: 'pty-native',
    incarnationId: 'incarnation-native'
  })
  expect(f.hostAdapters.getWorkerCodexAccountEnv).not.toHaveBeenCalled()
  expect(f.hostAdapters.subscribeToPtyExit).toHaveBeenCalledTimes(1)
  expect(f.stats).toMatchObject({ starts: 1, provisions: 1, maximum: 1 })
})

it('atomically hands off the exact one-hop PTY admission then reads live full policy on the next turn', async () => {
  const f = await fixture()
  f.plans.add(nativeLaunchId)
  const original = preparePtyAccountPoolLaunch({
    runtime: f.runtime,
    agent: 'codex',
    adopted: false,
    resume: false,
    wsl: false
  })
  if (!original) {
    throw new Error('Missing original synthetic PTY admission')
  }
  const env = await original.prepareEnv()
  original.bind('pty-native', false, false, 'incarnation-native')
  const plan = await prepareNativeCliAccountLaunch(f.runtime, {
    ...request,
    accountId: original.assignment.accountId,
    initialAssignmentOwnerKey: env[NATIVE_CLI_INITIAL_ASSIGNMENT_ENV]
  })
  expect(f.db.listAccountPoolAssignments()[0].ownerKey).toBe(original.assignment.ownerKey)
  expect((await nativePlanTurn(plan)).status).toBe(200)
  expect(f.db.listAccountPoolAssignments()).toHaveLength(1)
  expect(f.db.listAccountPoolAssignments()[0].ownerKey).not.toBe(original.assignment.ownerKey)
  const policy = f.settings.accountPools?.[0]
  if (!policy) {
    throw new Error('Missing saved pool')
  }
  policy.revision++
  policy.members[0].state = 'disabled'
  expect((await nativePlanTurn(plan, '2')).status).toBe(200)
  expect(f.db.listAccountPoolAssignments()[0].accountId).toBe(f.b.id)
  expect(f.hostAdapters.subscribeToPtyExit).toHaveBeenCalledTimes(2)
  expect(plan.env.CODEX_HOME).toBe(realpathSync(f.home))
})

it('gives a separately spawned nested CLI a fresh admission without stealing its live parent lease', async () => {
  const f = await fixture()
  f.plans.add(nativeLaunchId)
  f.plans.add(nestedLaunchId)
  const parent = await prepareNativeCliAccountLaunch(f.runtime, request)
  await nativePlanTurn(parent)
  const original = f.db.listAccountPoolAssignments()[0]
  const child = await prepareNativeCliAccountLaunch(f.runtime, {
    ...request,
    launchId: nestedLaunchId,
    initialAssignmentOwnerKey: original.ownerKey
  })
  expect((await nativePlanTurn(child)).status).toBe(200)
  expect(f.db.listAccountPoolAssignments()).toHaveLength(2)
  expect(
    f.db.listAccountPoolAssignments().find((row) => row.ownerKey === original.ownerKey)
  ).toEqual(original)
  expect(
    f.db.listAccountPoolAssignments().find((row) => row.ownerKey !== original.ownerKey)?.accountId
  ).toBe(f.b.id)
  await releaseNativeCliAccountLaunch(f.runtime, nestedLaunchId)
  expect(f.db.listAccountPoolAssignments()).toEqual([original])
  expect((await nativePlanTurn(parent, '2')).status).toBe(200)
})

it('does not transfer another legacy admission without the exact one-hop owner proof', async () => {
  const f = await fixture()
  f.plans.add(nativeLaunchId)
  const original = preparePtyAccountPoolLaunch({
    runtime: f.runtime,
    agent: 'codex',
    adopted: false,
    resume: false,
    wsl: false
  })
  if (!original) {
    throw new Error('Missing original admission')
  }
  original.bind('pty-native', false, false, 'incarnation-native')
  const plan = await prepareNativeCliAccountLaunch(f.runtime, request)
  expect((await nativePlanTurn(plan)).status).toBe(200)
  expect(f.db.listAccountPoolAssignments()).toHaveLength(2)
  expect(
    f.db.listAccountPoolAssignments().some((row) => row.ownerKey === original.assignment.ownerKey)
  ).toBe(true)
})

it('preserves custom provider selection and manual native fallback without provisioning', async () => {
  const f = await fixture()
  routingHooks.provider.mockResolvedValue('custom-provider')
  expect(
    await prepareNativeCodexRoutingLaunch(f.runtime, request, f.settings.accountPools?.[0])
  ).toBeNull()
  expect(f.stats.provisions).toBe(0)
  routingHooks.provider.mockResolvedValue('openai')
  f.settings.accountPools = []
  f.snapshot.codex.activeAccountId = null
  const plan = await prepareNativeCliAccountLaunch(f.runtime, {
    provider: 'codex',
    launchId: nativeLaunchId
  })
  expect(plan.env).toEqual({ CODEX_HOME: f.sourceHome })
  expect(plan.codexConfigOverrides).toBeUndefined()
  expect(f.stats.provisions).toBe(0)
})

it('fails before provisioning for unsupported gateway or absent verified pool grants', async () => {
  const f = await fixture()
  routingHooks.supported.mockReturnValue(false)
  await expect(prepareNativeCliAccountLaunch(f.runtime, request)).rejects.toThrow(
    /unavailable.*platform/
  )
  routingHooks.provider.mockResolvedValue('custom')
  expect(
    await prepareNativeCodexRoutingLaunch(f.runtime, request, f.settings.accountPools?.[0])
  ).toBeNull()
  routingHooks.supported.mockReturnValue(true)
  routingHooks.provider.mockResolvedValue('openai')
  for (const account of [f.a, f.b]) {
    rmSync(join(f.directory, 'codex-routing', 'connections', account.id, 'connection.json'))
  }
  await expect(prepareNativeCliAccountLaunch(f.runtime, request)).rejects.toThrow(
    /Connect.*pool account/
  )
  expect(f.stats.provisions).toBe(0)
  expect(f.db.listAccountPoolAssignments()).toEqual([])
})

it('does not leak a transition subscription when PTY exit fires synchronously during registration', async () => {
  const f = await fixture()
  f.terminal.syncExit = true
  await expect(prepareNativeCliAccountLaunch(f.runtime, request)).rejects.toThrow(
    /exited before routing/
  )
  expect(f.listeners.size).toBe(0)
  expect(f.exits.size).toBe(0)
  expect(f.db.listAccountPoolAssignments()).toEqual([])
})

it('records complete quota rejection without rebinding when canonical descendant proof is unavailable', async () => {
  const f = await fixture()
  f.plans.add(nativeLaunchId)
  const stamp = vi.fn(() => true)
  f.installation.recordQuotaFailure = stamp
  f.stats.quotaOnce = true
  const plan = await prepareNativeCliAccountLaunch(f.runtime, request)
  expect((await nativePlanTurn(plan)).status).toBe(429)
  expect(stamp).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ accountId: f.a.id, code: 'usage_limit_reached' })
  )
  expect(f.stats.models).toHaveLength(1)
  expect(new Set(f.stats.models.map((model) => model.split('/')[0])).size).toBe(1)
  expect(f.db.listAccountPoolAssignments()).toHaveLength(1)
  expect(f.db.listAccountPoolAssignments()[0]).toMatchObject({
    accountId: f.a.id,
    ptyId: 'pty-native'
  })
  expect(f.hostAdapters.subscribeToPtyExit).toHaveBeenCalledTimes(1)
})

it('chooses connected B over higher-priority native-roster-ready A without an engine connection', async () => {
  const f = await fixture()
  f.plans.add(nativeLaunchId)
  removeEngineGrantConnection(join(f.directory, 'codex-routing'), f.a.id)
  const plan = await prepareNativeCliAccountLaunch(f.runtime, request)
  expect((await nativePlanTurn(plan)).status).toBe(200)
  expect(f.db.listAccountPoolAssignments()[0].accountId).toBe(f.b.id)
  expect(f.settings.codexManagedAccounts?.map((account) => account.id)).toContain(f.a.id)
})

it('refreshes a previously unready canonical Stop before the next native HTTP admission', async () => {
  const f = await fixture()
  f.plans.add(nativeLaunchId)
  let settled = false
  const order: string[] = []
  routingHooks.boundary.mockImplementation(() => ({
    canSwitch: () => settled,
    refreshNativeEvidence: () => {
      order.push('refresh')
      settled = true
    },
    snapshot: () => {
      order.push('snapshot')
      const ready = settled
      return { canSwitch: () => ready, onBoundaryAccepted: () => {} }
    },
    dispose: () => {}
  }))
  const plan = await prepareNativeCliAccountLaunch(f.runtime, request)
  expect((await nativePlanTurn(plan)).status).toBe(200)
  expect(f.db.listAccountPoolAssignments()[0].accountId).toBe(f.a.id)
  const policy = f.settings.accountPools?.[0]
  if (!policy) {
    throw new Error('Missing saved pool')
  }
  policy.revision++
  policy.members[0].state = 'disabled'
  expect(order).not.toContain('refresh')
  expect((await nativePlanTurn(plan, '2')).status).toBe(200)
  expect(order.slice(-2)).toEqual(['refresh', 'snapshot'])
  expect(f.db.listAccountPoolAssignments()[0].accountId).toBe(f.b.id)
})
