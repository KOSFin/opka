import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { engineHostFixture, syntheticTurn } from './codex-engine-host-fixture'
import { engineCredentialFilename } from './engine-account-connection'

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

it('holds roster mutation authority and removes a deleted account before the new engine loads auth', async () => {
  const f = fixture()
  f.accounts.delete(f.a.id)
  let leased = false
  f.options.withAccountMutationLease = async (operation) => {
    leased = true
    try {
      return await operation()
    } finally {
      leased = false
    }
  }
  const start = f.options.startRuntime
  if (!start) {
    throw new Error('Missing synthetic runtime')
  }
  f.options.startRuntime = async (options) => {
    expect(leased).toBe(true)
    expect(existsSync(join(f.directory, 'active-auth', engineCredentialFilename(f.a.id)))).toBe(
      false
    )
    return start(options)
  }
  const launch = await f.launch()
  expect((await syntheticTurn(launch)).status).toBe(200)
  expect(f.db.listAccountPoolAssignments()[0].accountId).toBe(f.b.id)
})

it('does not load or remove foreign credential files from the watched directory', async () => {
  const f = fixture()
  const foreign = join(f.directory, 'active-auth', 'foreign.json')
  writeFileSync(foreign, 'synthetic foreign auth', { mode: 0o600 })
  await expect(f.launch()).rejects.toThrow(/Unknown/)
  expect(f.stats.starts).toBe(0)
  expect(existsSync(foreign)).toBe(true)
})

it('refuses startup with a stale registered grant even if another account is ready', async () => {
  const f = fixture()
  f.accounts.set(f.a.id, { ...f.a, rosterRevision: 'native-reauth-r2' })
  await expect(f.launch()).rejects.toThrow(/verified connection/)
  expect(f.stats.starts).toBe(0)
  expect(existsSync(join(f.directory, 'active-auth', engineCredentialFilename(f.a.id)))).toBe(true)
})
