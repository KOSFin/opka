import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { engineHostFixture, tick } from './codex-engine-host-fixture'
import type { CodexEngineHostOptions } from './codex-engine-host'

const fixtures: ReturnType<typeof engineHostFixture>[] = []
const fixture = (ensureAsset?: CodexEngineHostOptions['ensureAsset']) => {
  const f = engineHostFixture(30, { ensureAsset })
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.cleanup()
  }
})

it('returns pollable starting before a slow asset preparation and cancels it without creating enrollment files', async () => {
  let preparation: AbortSignal | undefined
  const f = fixture(async (options) => {
    preparation = options.signal
    await new Promise<void>((_resolve, reject) =>
      options.signal?.addEventListener(
        'abort',
        () => reject(new Error('synthetic cancelled download')),
        { once: true }
      )
    )
    throw new Error('Synthetic download unexpectedly completed')
  })
  const state = await f.host.beginGrant('owner', {
    accountId: f.a.id,
    expectedRosterRevision: 'r1'
  })
  await tick()
  expect(state.status).toBe('starting')
  expect(preparation).toBeDefined()
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(f.host.grant('owner', state.id).status).toBe('starting')
  f.host.cancelGrant('owner', state.id)
  await tick()
  expect(preparation?.aborted).toBe(true)
  expect(f.host.grant('owner', state.id).status).toBe('cancelled')
  expect(readdirSync(join(f.directory, 'staging'))).toEqual([])
  expect(readdirSync(join(f.directory, 'runtime'))).toEqual([])
  expect(f.login()).toBeUndefined()
})

it('reports a failed lazy binary preparation through the existing owner polling state', async () => {
  const f = fixture(async () => {
    throw new Error('synthetic private download failure')
  })
  const state = await f.host.beginGrant('owner', {
    accountId: f.a.id,
    expectedRosterRevision: 'r1'
  })
  await expect.poll(() => f.host.grant('owner', state.id).status).toBe('failed')
  expect(f.host.grant('owner', state.id)).not.toHaveProperty('userCode')
  expect(f.host.grant('owner', state.id).error).not.toContain('private download')
  expect(readdirSync(join(f.directory, 'staging'))).toEqual([])
})
