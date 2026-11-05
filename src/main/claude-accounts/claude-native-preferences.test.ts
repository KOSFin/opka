import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { openClaudeNativePreferences } from './claude-native-preferences'
import { claudeNativeFacadeSettings } from './claude-native-access-facade'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'opka-native-prefs-'))
  roots.push(root)
  const open = (id: string) => {
    const home = join(root, id)
    mkdirSync(home)
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({
        model: 'sonnet',
        mcpServers: { native: { env: { API_KEY: 'fake-private-mcp-reference' } } },
        apiKeyHelper: 'foreign-helper'
      })
    )
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        theme: 'dark',
        oauthAccount: { accountUuid: 'not-preferences' },
        primaryApiKey: 'fake-provider-auth',
        mcpServers: { native: {} }
      })
    )
    return {
      home,
      prefs: openClaudeNativePreferences({
        dataRoot: root,
        home,
        assertExclusive: () => {},
        projectSettings: claudeNativeFacadeSettings
      })
    }
  }
  return { root, open, master: join(root, 'native-cli-preferences', 'claude', 'preferences.json') }
}
const change = (home: string, patch: Record<string, unknown>) => {
  const path = join(home, 'settings.json')
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...patch }))
}
it('keeps native model/MCP edits for later Opka launches without copying provider auth', () => {
  const f = fixture(),
    a = f.open('a')
  change(a.home, { model: 'haiku', effort: 'high' })
  a.prefs.save()
  const b = f.open('b')
  expect(JSON.parse(readFileSync(join(b.home, 'settings.json'), 'utf8'))).toMatchObject({
    model: 'haiku',
    effort: 'high',
    mcpServers: { native: { env: { API_KEY: 'fake-private-mcp-reference' } } }
  })
  const raw = readFileSync(f.master, 'utf8')
  expect(raw).not.toMatch(/apiKeyHelper|oauthAccount|primaryApiKey|fake-provider-auth/)
})
it('merges independent concurrent native preferences and does not let an old close overwrite newer edits', () => {
  const f = fixture(),
    a = f.open('a'),
    b = f.open('b')
  change(a.home, { model: 'haiku' })
  a.prefs.save()
  change(b.home, { effort: 'high' })
  b.prefs.save()
  const value = JSON.parse(readFileSync(f.master, 'utf8'))
  expect(value.settings).toMatchObject({ model: 'haiku', effort: 'high' })
})
it('retains one bounded private conflict and refuses further launches without replacing newer preferences', () => {
  const f = fixture(),
    a = f.open('a'),
    b = f.open('b')
  change(a.home, { model: 'haiku' })
  a.prefs.save()
  change(b.home, { model: 'opus' })
  expect(() => b.prefs.save()).toThrow('conflict')
  expect(JSON.parse(readFileSync(f.master, 'utf8')).settings.model).toBe('haiku')
  expect(readdirSync(join(f.root, 'native-cli-preferences', 'claude')).sort()).toEqual([
    'conflict.json',
    'preferences.json'
  ])
  expect(() => f.open('c')).toThrow('conflict')
})
it('refuses manually injected provider-auth master fields rather than hydrating them', () => {
  const f = fixture()
  f.open('a')
  const value = JSON.parse(readFileSync(f.master, 'utf8'))
  writeFileSync(
    f.master,
    JSON.stringify({ ...value, state: { ...value.state, oauthAccount: { accountUuid: 'manual' } } })
  )
  expect(() => f.open('b')).toThrow('account-bound')
})

it('does not persist native startup counters or cache churn as user preference conflicts', () => {
  const f = fixture(),
    a = f.open('a'),
    b = f.open('b')
  for (const [home, count] of [
    [a.home, 10],
    [b.home, 20]
  ] as const) {
    const path = join(home, '.claude.json')
    writeFileSync(
      path,
      JSON.stringify({
        ...JSON.parse(readFileSync(path, 'utf8')),
        numStartups: count,
        cachedNativeUsage: { generated: count }
      })
    )
  }
  a.prefs.save()
  b.prefs.save()
  expect(readFileSync(f.master, 'utf8')).not.toMatch(/numStartups|cachedNativeUsage/)
})
