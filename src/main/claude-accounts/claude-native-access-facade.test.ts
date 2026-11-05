import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createClaudeNativeAccessFacade } from './claude-native-access-facade'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
const snapshot = (name: string) => ({
  access: {
    accessToken: `synthetic-${name}`,
    expiresAt: Date.now() + 3600_000,
    scopes: ['user:inference']
  },
  identity: {
    accountUuid: name,
    organizationUuid: `org-${name}`,
    emailAddress: `${name}@example.invalid`
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'opka-facade-owned-'))
  roots.push(root)
  const userHome = join(root, 'user')
  const defaults = join(userHome, '.claude')
  mkdirSync(defaults, { recursive: true })
  writeFileSync(
    join(defaults, 'settings.json'),
    JSON.stringify({
      apiKeyHelper: 'unrelated-global-auth',
      model: 'sonnet',
      env: { ANTHROPIC_API_KEY: 'synthetic', KEEP: 'true' },
      hooks: { Stop: [] }
    })
  )
  return {
    dataRoot: join(root, 'data'),
    sessionId: randomUUID(),
    userHome,
    snapshot: snapshot('A'),
    target: { executionHostId: 'local', runtime: 'host' } as const,
    assertExclusive: vi.fn()
  }
}

it('owns a disposable access-only profile while preserving native settings across account changes', async () => {
  const args = fixture()
  const facade = await createClaudeNativeAccessFacade(args)
  const settingsPath = join(facade.home, 'settings.json')
  expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
    model: 'sonnet',
    env: { KEEP: 'true' },
    hooks: { Stop: [] }
  })
  writeFileSync(
    settingsPath,
    JSON.stringify({
      model: 'haiku',
      env: { KEEP: 'true' },
      hooks: { Stop: [] },
      effortLevel: 'high'
    })
  )
  await facade.publish(snapshot('B'), () => true)
  expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({
    model: 'haiku',
    effortLevel: 'high'
  })
  expect(readFileSync(join(facade.home, '.credentials.json'), 'utf8')).not.toContain('refreshToken')
  const session = join(facade.home, 'projects', 'synthetic-session.jsonl')
  writeFileSync(session, 'synthetic native persisted history')
  await facade.dispose()
  expect(existsSync(facade.home)).toBe(false)
  expect(
    readFileSync(join(args.userHome, '.claude', 'projects', 'synthetic-session.jsonl'), 'utf8')
  ).toBe('synthetic native persisted history')
  expect(
    JSON.parse(readFileSync(join(args.userHome, '.claude', 'settings.json'), 'utf8')).apiKeyHelper
  ).toBe('unrelated-global-auth')
})

it('retains a manually authenticated profile instead of deleting or rewriting its login', async () => {
  const facade = await createClaudeNativeAccessFacade(fixture())
  const file = join(facade.home, '.credentials.json')
  const manual = JSON.stringify({
    claudeAiOauth: { ...snapshot('manual').access, refreshToken: 'synthetic-manual-only' }
  })
  writeFileSync(file, manual)
  await expect(facade.assertAccessCurrent()).rejects.toThrow('suspended')
  await expect(facade.publish(snapshot('B'), () => true)).rejects.toThrow('suspended')
  await expect(facade.dispose()).rejects.toThrow('suspended')
  expect(readFileSync(file, 'utf8')).toBe(manual)
})

it('checks the current access pair before an ordinary request while allowing native model changes', async () => {
  const facade = await createClaudeNativeAccessFacade(fixture())
  const file = join(facade.home, 'settings.json')
  const settings = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...settings, model: 'haiku' }))
  await expect(facade.assertAccessCurrent()).resolves.toBeUndefined()
  await facade.dispose()
})

it('also detects a same-account scoped Keychain login and never copies its credentials', async () => {
  const readScopedKeychain = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce('synthetic-private-keychain-document')
    .mockResolvedValue(null)
  const facade = await createClaudeNativeAccessFacade({
    ...fixture(),
    platform: 'darwin',
    readScopedKeychain
  })
  const before = readFileSync(join(facade.home, '.credentials.json'), 'utf8')
  await expect(facade.publish(snapshot('B'), () => true)).rejects.toThrow('manual Keychain login')
  await expect(facade.publish(snapshot('B'), () => true)).rejects.toThrow('manual Keychain login')
  expect(readFileSync(join(facade.home, '.credentials.json'), 'utf8')).toBe(before)
})

it('treats a later native apiKeyHelper edit as an explicit manual override', async () => {
  const facade = await createClaudeNativeAccessFacade(fixture())
  const file = join(facade.home, 'settings.json')
  const manual = JSON.stringify({ model: 'haiku', apiKeyHelper: 'native-user-choice' })
  writeFileSync(file, manual)
  await expect(facade.publish(snapshot('B'), () => true)).rejects.toThrow(
    'authentication settings changed'
  )
  expect(readFileSync(file, 'utf8')).toBe(manual)
})

it('refuses to reopen an existing facade without mutating its native login or settings', async () => {
  const args = fixture(),
    first = await createClaudeNativeAccessFacade(args)
  const credentials = readFileSync(join(first.home, '.credentials.json'), 'utf8')
  await expect(
    createClaudeNativeAccessFacade({ ...args, snapshot: snapshot('B') })
  ).rejects.toThrow('already owns')
  expect(readFileSync(join(first.home, '.credentials.json'), 'utf8')).toBe(credentials)
  await first.publish(snapshot('B'), () => true)
  await first.dispose()
})
it('cleans an unchanged fresh generation when initial access validation fails, without seeding preferences', async () => {
  const args = fixture()
  await expect(
    createClaudeNativeAccessFacade({
      ...args,
      snapshot: { ...args.snapshot, access: { ...args.snapshot.access, expiresAt: 0 } }
    })
  ).rejects.toThrow()
  expect(
    existsSync(join(args.dataRoot, 'native-cli-sessions', 'claude-profiles', args.sessionId))
  ).toBe(false)
  expect(
    existsSync(join(args.dataRoot, 'native-cli-preferences', 'claude', 'preferences.json'))
  ).toBe(false)
})
it('cleans only the unstarted facade on a retained preferences conflict and preserves the recovery slot', async () => {
  const args = fixture(),
    preferences = join(args.dataRoot, 'native-cli-preferences', 'claude')
  mkdirSync(preferences, { recursive: true })
  const conflict = join(preferences, 'conflict.json'),
    before = '{"recovery":"synthetic"}'
  writeFileSync(conflict, before, { mode: 0o600 })
  await expect(createClaudeNativeAccessFacade(args)).rejects.toThrow('retained conflict')
  expect(readFileSync(conflict, 'utf8')).toBe(before)
  expect(
    existsSync(join(args.dataRoot, 'native-cli-sessions', 'claude-profiles', args.sessionId))
  ).toBe(false)
})
it('retains an unknown manual Keychain profile and never opens preferences before refusing it', async () => {
  const args = fixture()
  await expect(
    createClaudeNativeAccessFacade({
      ...args,
      platform: 'darwin',
      readScopedKeychain: vi.fn().mockResolvedValue('synthetic-manual-keychain-login')
    })
  ).rejects.toThrow('manual Keychain login')
  expect(
    existsSync(join(args.dataRoot, 'native-cli-sessions', 'claude-profiles', args.sessionId))
  ).toBe(true)
  expect(
    existsSync(join(args.dataRoot, 'native-cli-preferences', 'claude', 'preferences.json'))
  ).toBe(false)
})
