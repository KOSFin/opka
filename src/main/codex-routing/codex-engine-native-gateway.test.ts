import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { engineHostFixture, syntheticTurn } from './codex-engine-host-fixture'

const fixtures: ReturnType<typeof engineHostFixture>[] = []
const fixture = () => {
  const value = engineHostFixture()
  fixtures.push(value)
  return value
}
afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    await value.cleanup()
  }
})

it('revokes the old launch nonce even with the same profile credential and live listener', async () => {
  const f = fixture()
  const first = await f.launch('first')
  expect((await syntheticTurn(first)).status).toBe(200)
  first.close('exited')
  const second = await f.launch('second')
  expect(second.apiKey).toBe(first.apiKey)
  expect((await syntheticTurn(first)).status).not.toBe(200)
  expect((await syntheticTurn(second)).status).toBe(200)
  expect(f.stats.models).toHaveLength(2)
})

it('rejects externally replaced profile credentials rather than publishing a different key to an existing listener', async () => {
  const f = fixture()
  const first = await f.launch('first')
  writeFileSync(join(f.directory, 'native-gateway-key'), 'f'.repeat(64), { mode: 0o600 })
  await expect(f.launch('second')).rejects.toThrow('credentials changed')
  expect((await syntheticTurn(first)).status).toBe(200)
  expect(f.stats.models).toHaveLength(1)
})

it('refuses new credential publication during shutdown', async () => {
  const f = fixture()
  f.host.beginShutdown()
  expect(() => f.host.getNativeClientKey()).toThrow('shutting down')
})
