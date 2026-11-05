import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readBoundedClaudeProfileJson } from './claude-native-access'
import { createClaudeNativeFacadePublication } from './claude-native-facade-publication'
import { claudeNativeFacadeSettings } from './claude-native-access-facade'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
const pair = (id: string) => ({
  access: {
    accessToken: `fake-${id}`,
    expiresAt: Date.now() + 3600_000,
    scopes: ['user:inference']
  },
  identity: {
    accountUuid: id,
    organizationUuid: `org-${id}`,
    emailAddress: `${id}@example.invalid`
  }
})
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'opka-facade-'))
  roots.push(home)
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({ model: 'sonnet', mcpServers: { custom: {} }, oauthAccount: {} })
  )
  const initial = pair('A')
  const publication = createClaudeNativeFacadePublication(home, initial)
  publication.initialize()
  return { home, publication, initial }
}

it('keeps native model/MCP/settings changes across 1000 switches without refresh tokens or orphan files', () => {
  const { home, publication } = fixture()
  const stateFile = join(home, '.claude.json')
  const native = JSON.parse(readFileSync(stateFile, 'utf8'))
  writeFileSync(stateFile, JSON.stringify({ ...native, model: 'haiku', nativePreference: 'keep' }))
  for (let i = 0; i < 1000; i++) {
    publication.publish(pair(i % 2 ? 'A' : 'B'), () => true)
  }
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  expect(state).toMatchObject({
    model: 'haiku',
    nativePreference: 'keep',
    mcpServers: { custom: {} },
    oauthAccount: { accountUuid: 'A' }
  })
  expect(readFileSync(join(home, '.credentials.json'), 'utf8')).not.toContain('refreshToken')
  expect(readdirSync(home).sort()).toEqual(['.claude.json', '.credentials.json'])
})

it('recovers an interrupted credential-first pair while preserving unrelated native metadata', () => {
  const { home, initial } = fixture()
  const next = pair('B')
  writeFileSync(
    join(home, '.opka-access-pending.json'),
    JSON.stringify({ version: 1, from: initial, to: next })
  )
  writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: next.access }))
  const restored = createClaudeNativeFacadePublication(home, initial)
  restored.recover()
  restored.assertUnchanged()
  expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toMatchObject({
    model: 'sonnet',
    oauthAccount: next.identity
  })
  expect(readdirSync(home)).not.toContain('.opka-access-pending.json')
})

it('recovers a crash while the existing guarded writer temporarily held the credential file', () => {
  const { home, initial } = fixture()
  const next = pair('B')
  writeFileSync(
    join(home, '.opka-access-pending.json'),
    JSON.stringify({ version: 1, from: initial, to: next })
  )
  renameSync(join(home, '.credentials.json'), join(home, '.credentials.json.orca-guarded'))
  const restored = createClaudeNativeFacadePublication(home, initial)
  restored.recover()
  expect(JSON.parse(readFileSync(join(home, '.credentials.json'), 'utf8'))).toEqual({
    claudeAiOauth: next.access
  })
  expect(readdirSync(home).sort()).toEqual(['.claude.json', '.credentials.json'])
})

it('preserves a user login with a refresh token and suspends subsequent automatic writes', () => {
  const { home, publication } = fixture()
  const file = join(home, '.credentials.json')
  const manual = JSON.stringify({
    claudeAiOauth: { ...pair('manual').access, refreshToken: 'fake-manual-refresh' }
  })
  writeFileSync(file, manual)
  expect(() => publication.publish(pair('B'), () => true)).toThrow('suspended')
  expect(readFileSync(file, 'utf8')).toBe(manual)
  expect(() => publication.publish(pair('B'), () => true)).toThrow('suspended')
})

it('refuses recovery over a manual identity change and keeps the pending receipt for review', () => {
  const { home, initial, publication } = fixture()
  writeFileSync(
    join(home, '.opka-access-pending.json'),
    JSON.stringify({ version: 1, from: initial, to: pair('B') })
  )
  const state = { oauthAccount: pair('manual').identity, keep: true }
  writeFileSync(join(home, '.claude.json'), JSON.stringify(state))
  expect(() => publication.recover()).toThrow('suspended')
  expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual(state)
})

it('requires a canonical boundary before publishing any auth surface', () => {
  const { home, publication } = fixture()
  const before = readFileSync(join(home, '.credentials.json'), 'utf8')
  expect(() => publication.publish(pair('B'), () => false)).toThrow('suspended')
  expect(readFileSync(join(home, '.credentials.json'), 'utf8')).toBe(before)
})

it('removes auth provenance while retaining native features in the initial settings copy', () => {
  expect(
    claudeNativeFacadeSettings({
      apiKeyHelper: 'custom-auth',
      model: 'haiku',
      hooks: { Stop: [] },
      env: { ANTHROPIC_API_KEY: 'fake', ANTHROPIC_BASE_URL: 'fake', KEEP: 'yes' },
      mcpServers: { native: {} }
    })
  ).toEqual({
    model: 'haiku',
    hooks: { Stop: [] },
    env: { KEEP: 'yes' },
    mcpServers: { native: {} }
  })
})
it('preserves account capability metadata but refuses credentials hidden in the identity object', () => {
  const { home, publication } = fixture()
  const next = pair('B')
  publication.publish(
    {
      ...next,
      identity: { ...next.identity, hasExtraUsageEnabled: true, organizationRole: 'admin' }
    },
    () => true
  )
  expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).oauthAccount).toMatchObject({
    accountUuid: 'B',
    hasExtraUsageEnabled: true,
    organizationRole: 'admin'
  })
  expect(() =>
    publication.publish(
      { ...pair('A'), identity: { ...pair('A').identity, refreshToken: 'synthetic-forbidden' } },
      () => true
    )
  ).toThrow('suspended')
  expect(readFileSync(join(home, '.claude.json'), 'utf8')).not.toContain('synthetic-forbidden')
})

it('never includes private native JSON content in a malformed-profile diagnostic', () => {
  const f = fixture(),
    path = join(f.home, 'settings.json')
  writeFileSync(path, '{"MCP_PRIVATE_TOKEN":"synthetic-private-value", broken')
  expect(() => readBoundedClaudeProfileJson(path)).toThrow(
    'Claude native profile JSON is unreadable.'
  )
  try {
    readBoundedClaudeProfileJson(path)
  } catch (error) {
    expect(String(error)).not.toMatch(/MCP_PRIVATE_TOKEN|synthetic-private-value/)
  }
})
