import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClaudeNativeAccessFacade } from './claude-native-access-facade'
import { readClaudeNativeAccessSnapshot } from './claude-native-access'
import { afterEach, expect, it, vi } from 'vitest'
import * as nativeRefresh from './claude-native-refresh-authority'
import { reserveEngineWriter } from '../codex-routing/engine-writer-ownership'
import { ClaudeNativeRefreshSources } from './claude-native-refresh-sources'
import { nativeSourceFixture } from './claude-native-source-test-fixtures'

const roots: string[] = []
const fixture = () => {
  const f = nativeSourceFixture()
  roots.push(f.root)
  return f
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('never adopts the legacy/global source and attests a separate fresh native login under the same roster UUID', async () => {
  const f = fixture()
  const sources = new ClaudeNativeRefreshSources(f.options)
  expect(await sources.state(f.account.id)).toEqual({ state: 'needs-sign-in' })
  expect(await sources.signIn(f.account.id)).toEqual({ state: 'ready', nativeVersion: '2.1.318' })
  expect(f.options.accounts.listAccounts().accounts).toEqual([f.account])
  expect(f.attestation()).toMatchObject({
    accountId: f.account.id,
    identity: f.identity,
    nativeVersion: '2.1.318'
  })
  expect(readFileSync(f.legacy, 'utf8')).toBe('synthetic legacy source must remain untouched')
  expect(f.login.mock.calls[0][0].home).toContain('claude-native-refresh-sources')
  expect(f.login.mock.calls[0][0].nativeUserHome).toBe(f.options.userHome)
  await sources.shutdown()
})

it('removes safely closed failed owned generations across repeated retries', async () => {
  const f = fixture()
  f.login.mockImplementation(async ({ home }) => {
    f.writeLogin(home)
    throw new Error('synthetic failure')
  })
  const sources = new ClaudeNativeRefreshSources(f.options)
  for (let index = 0; index < 10; index++) {
    await expect(sources.signIn(f.account.id)).rejects.toThrow('did not finish')
  }
  expect(readdirSync(join(f.sourceRoot, 'claude-profiles'))).toEqual([])
  expect(existsSync(join(f.sourceRoot, 'active-source.json'))).toBe(false)
})

it('retains an unverifiable pending writer and refuses further generations or refresh', async () => {
  const f = fixture()
  f.login.mockImplementation(async ({ writerDirectory }) => {
    reserveEngineWriter({
      directory: writerDirectory,
      assertExclusive: f.options.assertExclusiveProfile
    })
    throw new Error('unknown native writer')
  })
  const sources = new ClaudeNativeRefreshSources(f.options)
  await expect(sources.signIn(f.account.id)).rejects.toThrow('did not finish')
  for (let index = 0; index < 3; index++) {
    await expect(sources.signIn(f.account.id)).rejects.toThrow()
  }
  expect(readdirSync(join(f.sourceRoot, 'claude-profiles'))).toHaveLength(1)
  await expect(sources.refresh(f.account.id)).rejects.toThrow()
  await expect(sources.shutdown()).rejects.toThrow()
})

it('refuses identity drift without changing the saved account or retaining a closed wrong-login generation', async () => {
  const f = fixture()
  f.login.mockImplementation(async ({ home }) => {
    f.writeLogin(home, 'other@example.invalid')
  })
  const sources = new ClaudeNativeRefreshSources(f.options)
  await expect(sources.signIn(f.account.id)).rejects.toThrow('did not finish')
  expect(f.options.accounts.listAccounts().accounts).toEqual([f.account])
  expect(readdirSync(join(f.sourceRoot, 'claude-profiles'))).toEqual([])
})

it('requires exact resolved native version and an exclusive captured host profile lease', async () => {
  const f = fixture()
  const unsupported = new ClaudeNativeRefreshSources({
    ...f.options,
    resolveLaunch: async () => ({ command: '/synthetic/claude', args: [], version: '2.1.319' })
  })
  expect(await unsupported.state(f.account.id)).toEqual({ state: 'unsupported' })
  await expect(unsupported.signIn(f.account.id)).rejects.toThrow('capability')
  expect(f.login).not.toHaveBeenCalled()
  f.loseProfile()
  const stale = new ClaudeNativeRefreshSources(f.options)
  expect(() => stale.signIn(f.account.id)).toThrow('profile ownership')
})

it('rejects a copied attestation from another host and never falls back to System default', async () => {
  const f = fixture()
  const sources = new ClaudeNativeRefreshSources(f.options)
  await sources.signIn(f.account.id)
  writeFileSync(
    join(f.sourceRoot, 'active-source.json'),
    JSON.stringify({ ...f.attestation(), machine: '0'.repeat(64) }),
    { mode: 0o600 }
  )
  expect(await sources.state(f.account.id)).toEqual({ state: 'unverifiable' })
  await expect(sources.refresh(f.account.id)).rejects.toThrow('identity changed')
})

it('retires only a proven closed dedicated source without deleting the legacy default or non-auth master', async () => {
  const f = fixture(),
    sources = new ClaudeNativeRefreshSources(f.options)
  await sources.signIn(f.account.id)
  const home = join(f.sourceRoot, 'claude-profiles', f.attestation().generation, 'home')
  const snapshot = await readClaudeNativeAccessSnapshot(home, f.identity)
  if (!snapshot) {
    throw new Error('Missing synthetic source access')
  }
  const facade = await createClaudeNativeAccessFacade({
    dataRoot: f.options.dataRoot,
    sessionId: randomUUID(),
    target: { runtime: 'host', executionHostId: 'local' },
    userHome: f.options.userHome,
    snapshot,
    assertExclusive: f.options.assertExclusiveProfile
  })
  await expect(
    f.options.accounts.withNativeRoutingMutation(() =>
      sources.retireFromOwnedMutation(f.account.id)
    )
  ).rejects.toThrow('unverifiable')
  expect(existsSync(home)).toBe(true)
  await facade.dispose()
  await f.options.accounts.withNativeRoutingMutation(() =>
    sources.retireFromOwnedMutation(f.account.id)
  )
  expect(existsSync(f.sourceRoot)).toBe(false)
  expect(readFileSync(f.legacy, 'utf8')).toBe('synthetic legacy source must remain untouched')
  expect(
    existsSync(join(f.options.dataRoot, 'native-cli-preferences', 'claude', 'preferences.json'))
  ).toBe(true)
  await sources.shutdown()
})
it('does not admit an attested source whose native refresh credential disappeared', async () => {
  const f = fixture(),
    sources = new ClaudeNativeRefreshSources(f.options)
  await sources.signIn(f.account.id)
  const file = join(
    f.sourceRoot,
    'claude-profiles',
    f.attestation().generation,
    'home',
    '.credentials.json'
  )
  writeFileSync(
    file,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fake-AT-only',
        expiresAt: Date.now() + 3600000,
        scopes: ['user:inference']
      }
    })
  )
  expect(await sources.readyAccountIds()).toEqual(new Set())
  expect(await sources.state(f.account.id)).toMatchObject({ state: 'needs-sign-in' })
  await sources.shutdown()
})

it('forwards trusted host HOME to the refresh authority while keeping the separate owned source', async () => {
  const f = fixture(),
    sources = new ClaudeNativeRefreshSources(f.options)
  await sources.signIn(f.account.id)
  const refresh = vi
    .spyOn(nativeRefresh, 'refreshClaudeNativeAccess')
    .mockImplementation(async (source) => {
      expect(source.nativeUserHome).toBe(f.options.userHome)
      expect(source.configDir).not.toBe(f.options.userHome)
      source.assertExclusive()
      const snapshot = await readClaudeNativeAccessSnapshot(
        source.configDir,
        source.expectedIdentity
      )
      if (!snapshot) {
        throw new Error('Missing synthetic source access')
      }
      return snapshot
    })
  try {
    const result = await sources.refresh(f.account.id)
    expect(result.identity).toEqual(f.identity)
    expect(refresh).toHaveBeenCalledOnce()
  } finally {
    refresh.mockRestore()
    await sources.shutdown()
  }
})
