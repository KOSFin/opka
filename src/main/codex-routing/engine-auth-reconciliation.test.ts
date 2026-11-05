import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { publishEngineGrant, readEngineGrantConnection } from './engine-grant-files'
import { reconcileEngineAuthDirectory } from './engine-auth-reconciliation'
import { reserveEngineWriter } from './engine-writer-ownership'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'opka-auth-recovery-'))
  roots.push(directory)
  const accounts = [1, 2].map((index) => ({
    id: `10000000-0000-4000-8000-00000000000${index}`,
    providerAccountId: `provider-${index}`,
    rosterRevision: 'r1'
  }))
  const files = accounts.map((account) => {
    const grant = JSON.stringify({
      type: 'codex',
      account_id: account.providerAccountId,
      access_token: 'synthetic',
      refresh_token: 'synthetic',
      id_token: `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account.providerAccountId } })).toString('base64url')}.synthetic`
    })
    const descriptor = publishEngineGrant(directory, account, grant)
    return join(directory, 'active-auth', descriptor.credentialId)
  })
  return {
    directory,
    accounts,
    files,
    run: () =>
      reconcileEngineAuthDirectory({ directory, accounts, assertExclusiveProfile: () => {} })
  }
}
it('removes a deleted roster grant and descriptor before a later engine can watch them', () => {
  const f = fixture()
  const deleted = f.accounts.shift()
  f.run()
  expect(existsSync(f.files[0])).toBe(false)
  expect(existsSync(join(f.directory, 'connections', deleted?.id ?? 'missing'))).toBe(false)
  expect(readEngineGrantConnection(f.directory, f.accounts[0])).not.toBeNull()
})
it('preserves unknown credential files and refuses the entire startup', () => {
  const f = fixture()
  const unknown = join(f.directory, 'active-auth', 'foreign.json')
  writeFileSync(unknown, 'synthetic foreign credential', { mode: 0o600 })
  f.accounts.shift()
  expect(f.run).toThrow(/Unknown/)
  expect(readFileSync(unknown, 'utf8')).toBe('synthetic foreign credential')
  expect(existsSync(f.files[0])).toBe(true)
})
it('preserves registered but unverified credentials instead of loading or deleting them', () => {
  const f = fixture()
  f.accounts[0].rosterRevision = 'native-reauth-r2'
  expect(f.run).toThrow(/verified connection/)
  expect(existsSync(f.files[0])).toBe(true)
})
it('recognizes pinned empty lock files and cleans only owned unpublished refresh temporaries', () => {
  const f = fixture()
  writeFileSync(`${f.files[0]}.lock`, '', { mode: 0o600 })
  writeFileSync(`${f.files[0]}.tmp.123456789`, 'synthetic partial refresh', { mode: 0o600 })
  writeFileSync(
    `${f.files[0]}.123.10000000-0000-4000-8000-000000000003.tmp`,
    'synthetic partial activation',
    { mode: 0o600 }
  )
  f.run()
  expect(existsSync(`${f.files[0]}.lock`)).toBe(true)
  expect(existsSync(`${f.files[0]}.tmp.123456789`)).toBe(false)
  expect(existsSync(`${f.files[0]}.123.10000000-0000-4000-8000-000000000003.tmp`)).toBe(false)
})
it('does not clean credentials while a previous writer remains unverifiable', () => {
  const f = fixture()
  f.accounts.shift()
  const writer = reserveEngineWriter({
    directory: join(f.directory, 'runtime'),
    assertExclusive: () => {}
  })
  expect(f.run).toThrow(/writer|host/)
  expect(existsSync(f.files[0])).toBe(true)
  writer.cancelBeforeSpawn()
})
it('refuses unexpected watched directories without following or deleting them', () => {
  const f = fixture()
  mkdirSync(join(f.directory, 'active-auth', 'unexpected-directory'))
  expect(f.run).toThrow(/Unknown/)
  expect(existsSync(join(f.directory, 'active-auth', 'unexpected-directory'))).toBe(true)
})
it('refuses more than 256 entries before deleting any owned temporary files', () => {
  const f = fixture()
  for (let index = 0; index < 255; index++) {
    writeFileSync(`${f.files[0]}.tmp.${100000000 + index}`, '', { mode: 0o600 })
  }
  expect(f.run).toThrow(/recovery/)
  expect(existsSync(`${f.files[0]}.tmp.100000000`)).toBe(true)
})
