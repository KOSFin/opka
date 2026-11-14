import { afterEach, expect, it, vi } from 'vitest'
import {
  nativeRoutingFixture,
  nativePlanTurn,
  nativeLaunchId,
  parentProof
} from './native-codex-routing-launch-fixture'
import {
  prepareNativeCliAccountLaunch,
  releaseNativeCliAccountLaunch
} from './native-cli-account-launch'
import { nativeCliTerminalBindings } from './native-cli-terminal-bindings'
import {
  attachNativeCodexRoutingOwner,
  registerNativeCodexRoutingOwner,
  revokeNativeCodexRoutingLaunch,
  isNativeCodexRoutingLaunch,
  isNativeCodexRoutingEnvironment,
  claimNativeCodexHistoryHome,
  assertNativeCodexHistoryHomeUnused
} from './native-codex-routing-ownership'
import { preparePtyAccountPoolLaunch } from '../ipc/pty/account-pool-launch'
import { NATIVE_CODEX_ROUTING_KEY_ENV } from '../../shared/native-cli-account-launch'

const fixtures: Awaited<ReturnType<typeof nativeRoutingFixture>>[] = []
async function fixture() {
  const f = await nativeRoutingFixture()
  fixtures.push(f)
  f.plans.add(nativeLaunchId)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.cleanup()
  }
})
function externalBinding(env: Record<string, string>) {
  return {
    launchId: nativeLaunchId,
    paneKey: parentProof.paneKey,
    worktreeId: 'work-native',
    rotating: false,
    waiters: new Set<() => void>(),
    env,
    inputTail: Promise.resolve(),
    pendingInputChars: 0,
    cols: 80,
    rows: 24,
    incarnationId: 'incarnation-native',
    inputReady: false,
    attached: false
  }
}

it('binds late-created external PTY ownership and cleans a detached binding only after its observed exit', async () => {
  const f = await fixture()
  const plan = await prepareNativeCliAccountLaunch(f.runtime, {
    provider: 'codex',
    codexExecutable: process.execPath,
    launchId: nativeLaunchId
  })
  expect((await nativePlanTurn(plan)).status).toBe(200)
  expect(f.db.listAccountPoolAssignments()[0].ptyId).toBeNull()
  const binding = externalBinding({ ...plan.env })
  const waiter = vi.fn()
  binding.waiters.add(waiter)
  nativeCliTerminalBindings(f.runtime).set(nativeLaunchId, binding)
  attachNativeCodexRoutingOwner(f.runtime, nativeLaunchId)
  expect(f.db.listAccountPoolAssignments()[0].ptyId).toBe('pty-native')
  f.terminal.connected = false
  expect(nativeCliTerminalBindings(f.runtime).has(nativeLaunchId)).toBe(true)
  expect(isNativeCodexRoutingLaunch(f.runtime, nativeLaunchId)).toBe(true)
  for (const exit of f.exits) {
    exit()
  }
  await expect.poll(() => f.db.listAccountPoolAssignments().length).toBe(0)
  expect(nativeCliTerminalBindings(f.runtime).has(nativeLaunchId)).toBe(false)
  expect(binding.env).toEqual({})
  expect(waiter).toHaveBeenCalledOnce()
  expect(f.listeners.size).toBe(0)
})

it('preserves a replacement binding when a stale PTY-exit observer reports an older incarnation', async () => {
  const f = await fixture()
  const plan = await prepareNativeCliAccountLaunch(f.runtime, {
    provider: 'codex',
    codexExecutable: process.execPath,
    launchId: nativeLaunchId
  })
  const binding = externalBinding({ ...plan.env })
  nativeCliTerminalBindings(f.runtime).set(nativeLaunchId, binding)
  attachNativeCodexRoutingOwner(f.runtime, nativeLaunchId)
  f.terminal.incarnation = 'replacement-incarnation'
  binding.incarnationId = f.terminal.incarnation
  for (const exit of f.exits) {
    exit()
  }
  expect(nativeCliTerminalBindings(f.runtime).get(nativeLaunchId)).toBe(binding)
  expect(binding.env[NATIVE_CODEX_ROUTING_KEY_ENV]).toBe(plan.env[NATIVE_CODEX_ROUTING_KEY_ENV])
  expect(isNativeCodexRoutingLaunch(f.runtime, nativeLaunchId)).toBe(true)
})

it('retains one CLI exit observer across repeated hot account selections', async () => {
  const f = await fixture()
  const plan = await prepareNativeCliAccountLaunch(f.runtime, {
    provider: 'codex',
    codexExecutable: process.execPath,
    launchId: nativeLaunchId,
    parentTerminal: parentProof
  })
  const policy = f.settings.accountPools?.[0]
  if (!policy) {
    throw new Error('Missing saved pool')
  }
  for (let index = 0; index < 10; index++) {
    policy.revision++
    policy.members[0].priority = index % 2 ? 3 : 1
    expect((await nativePlanTurn(plan, `${index}`)).status).toBe(200)
    expect(f.db.listAccountPoolAssignments()).toHaveLength(1)
  }
  expect(new Set(f.stats.models.map((model) => model.split('/')[0])).size).toBe(2)
  expect(f.hostAdapters.subscribeToPtyExit).toHaveBeenCalledTimes(1)
})

it('suppresses lower legacy admission only for an exact live gateway capability', async () => {
  const f = await fixture()
  const plan = await prepareNativeCliAccountLaunch(f.runtime, {
    provider: 'codex',
    codexExecutable: process.execPath,
    launchId: nativeLaunchId
  })
  const args = {
    runtime: f.runtime,
    agent: 'codex' as const,
    adopted: false,
    resume: false,
    wsl: false
  }
  expect(preparePtyAccountPoolLaunch({ ...args, env: plan.env })).toBeUndefined()
  expect(f.db.listAccountPoolAssignments()).toEqual([])
  const arbitrary = preparePtyAccountPoolLaunch({
    ...args,
    env: { [NATIVE_CODEX_ROUTING_KEY_ENV]: 'unregistered-capability' }
  })
  expect(arbitrary).toBeDefined()
  arbitrary?.release()
})

it('preserves owned transcript readers when capability drain is unproven and disposes them only after verified drain', async () => {
  const f = await fixture()
  let fail = true
  const disposeSources = vi.fn()
  registerNativeCodexRoutingOwner(f.runtime, nativeLaunchId, {
    readOwner: () => null,
    routingKey: 'synthetic-owned-key',
    dispose: () => {},
    releaseHistory: disposeSources,
    revoke: async () => {
      if (fail) {
        throw new Error('synthetic unverified drain')
      }
    }
  })
  await expect(revokeNativeCodexRoutingLaunch(f.runtime, nativeLaunchId)).rejects.toThrow(
    /unverified/
  )
  expect(disposeSources).not.toHaveBeenCalled()
  expect(isNativeCodexRoutingLaunch(f.runtime, nativeLaunchId)).toBe(true)
  fail = false
  await revokeNativeCodexRoutingLaunch(f.runtime, nativeLaunchId)
  expect(disposeSources).toHaveBeenCalledOnce()
  expect(isNativeCodexRoutingLaunch(f.runtime, nativeLaunchId)).toBe(false)
})

it('does not let a retired launch marker borrow another active launch profile credential', async () => {
  const f = await fixture()
  const first = await prepareNativeCliAccountLaunch(f.runtime, {
    provider: 'codex',
    codexExecutable: process.execPath,
    launchId: nativeLaunchId
  })
  const secondId = '70000000-0000-4000-8000-000000000003'
  f.plans.add(secondId)
  const second = await prepareNativeCliAccountLaunch(f.runtime, {
    provider: 'codex',
    codexExecutable: process.execPath,
    launchId: secondId
  })
  expect(first.env[NATIVE_CODEX_ROUTING_KEY_ENV]).not.toBe(second.env[NATIVE_CODEX_ROUTING_KEY_ENV])
  expect(isNativeCodexRoutingEnvironment(f.runtime, first.env)).toBe(true)
  expect(isNativeCodexRoutingEnvironment(f.runtime, second.env)).toBe(true)
  await releaseNativeCliAccountLaunch(f.runtime, nativeLaunchId)
  expect(isNativeCodexRoutingEnvironment(f.runtime, first.env)).toBe(false)
  expect(isNativeCodexRoutingEnvironment(f.runtime, second.env)).toBe(true)
})

it('prepares and releases 100 native launcher capabilities with one shared history HOME', async () => {
  const f = await fixture()
  const policy = f.settings.accountPools?.[0]
  if (!policy) {
    throw new Error('Missing saved pool')
  }
  for (const member of policy.members) {
    member.maxConcurrent = undefined
  }
  const ids = Array.from({ length: 100 }, (_, index) => `parallel-native-${index}`)
  ids.forEach((id) => f.plans.add(id))
  const plans = await Promise.all(
    ids.map((launchId) =>
      prepareNativeCliAccountLaunch(f.runtime, {
        provider: 'codex',
        codexExecutable: process.execPath,
        launchId
      })
    )
  )
  expect(plans).toHaveLength(100)
  ids.forEach((id) => expect(isNativeCodexRoutingLaunch(f.runtime, id)).toBe(true))
  for (const plan of plans) {
    expect((await nativePlanTurn(plan)).status).toBe(200)
  }
  expect(f.db.listAccountPoolAssignments()).toHaveLength(100)
  await Promise.all(ids.map((id) => releaseNativeCliAccountLaunch(f.runtime, id)))
  ids.forEach((id) => expect(isNativeCodexRoutingLaunch(f.runtime, id)).toBe(false))
  expect(f.db.listAccountPoolAssignments()).toHaveLength(0)
})

it('retains the exact shared history claim until all 100 callers release it', () => {
  const home = '/synthetic-parallel-native-history'
  const releases = Array.from({ length: 100 }, () => claimNativeCodexHistoryHome(home))
  releases.slice(0, 99).forEach((release) => release())
  expect(() => assertNativeCodexHistoryHomeUnused(home)).toThrow('Close the native Codex dialog')
  releases[99]()
  expect(() => assertNativeCodexHistoryHomeUnused(home)).not.toThrow()
})
