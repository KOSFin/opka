import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
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
import { assertNativeCodexHistoryHomeUnused } from './native-codex-routing-ownership'
import { peekRuntimeCodexEngineHost } from './runtime-codex-engine-host'

const fixtures: Awaited<ReturnType<typeof nativeRoutingFixture>>[] = []
async function fixture() {
  const f = await nativeRoutingFixture()
  fixtures.push(f)
  f.plans.add(nativeLaunchId)
  const account = f.settings.codexManagedAccounts?.[0]
  if (!account) {
    throw new Error('Missing native history account')
  }
  account.managedHomePath = f.sourceHome
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.cleanup()
  }
})

it('protects HOME A dialog history while the live engine has switched the same CLI to account B', async () => {
  const f = await fixture()
  mkdirSync(join(f.sourceHome, 'sessions'), { recursive: true })
  const dialog = join(f.sourceHome, 'sessions', 'native-dialog.jsonl')
  writeFileSync(dialog, 'synthetic existing dialog\n')
  const plan = await prepareNativeCliAccountLaunch(f.runtime, {
    provider: 'codex',
    codexExecutable: process.execPath,
    launchId: nativeLaunchId,
    parentTerminal: parentProof
  })
  await nativePlanTurn(plan)
  const policy = f.settings.accountPools?.[0]
  if (!policy) {
    throw new Error('Missing pool')
  }
  policy.revision++
  policy.members[0].state = 'disabled'
  await nativePlanTurn(plan, '2')
  expect(f.db.listAccountPoolAssignments()[0].accountId).toBe(f.b.id)
  expect(() => assertNativeCodexHistoryHomeUnused(f.sourceHome)).toThrow(/history before removing/)
  expect(readFileSync(dialog, 'utf8')).toBe('synthetic existing dialog\n')
  await releaseNativeCliAccountLaunch(f.runtime, nativeLaunchId)
  expect(() => assertNativeCodexHistoryHomeUnused(f.sourceHome)).not.toThrow()
  expect(readFileSync(dialog, 'utf8')).toBe('synthetic existing dialog\n')
})

it('protects pending native history preparation and releases it when shutdown cancels the asset wait', async () => {
  const f = await fixture()
  f.installation.ensureAsset = async (options) => {
    await new Promise<void>((_resolve, reject) =>
      options.signal?.addEventListener(
        'abort',
        () => reject(new Error('synthetic aborted asset')),
        { once: true }
      )
    )
    throw new Error('Synthetic asset unexpectedly completed')
  }
  const result = prepareNativeCliAccountLaunch(f.runtime, {
    provider: 'codex',
    codexExecutable: process.execPath,
    launchId: nativeLaunchId,
    parentTerminal: parentProof
  }).catch((error) => error)
  await expect
    .poll(() => {
      try {
        assertNativeCodexHistoryHomeUnused(f.sourceHome)
        return false
      } catch {
        return true
      }
    })
    .toBe(true)
  await peekRuntimeCodexEngineHost(f.runtime)?.beginShutdown()
  expect(await result).toBeInstanceOf(Error)
  expect(() => assertNativeCodexHistoryHomeUnused(f.sourceHome)).not.toThrow()
})
