import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { reserveEngineWriter } from '../codex-routing/engine-writer-ownership'
import { ClaudeNativeRefreshSources } from './claude-native-refresh-sources'
import { ClaudeNativeSourceProfiles } from './claude-native-source-profile'
import { nativeSourceFixture } from './claude-native-source-test-fixtures'

const roots: string[] = []
const fixture = () => {
  const f = nativeSourceFixture()
  roots.push(f.root)
  return f
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

it('returns no native preparation for an unconnected roster account', async () => {
  const f = fixture(),
    profiles = new ClaudeNativeSourceProfiles(f.options)
  const refresh = vi.fn(async () => {})
  expect(await profiles.usagePreparation(f.account.id, refresh)).toBeUndefined()
  expect(refresh).not.toHaveBeenCalled()
})

it('reads only the owned refreshed source and keeps a failed refresh from falling back to legacy auth', async () => {
  const f = fixture(),
    sources = new ClaudeNativeRefreshSources(f.options)
  await sources.signIn(f.account.id)
  const profiles = new ClaudeNativeSourceProfiles(f.options)
  const home = join(f.sourceRoot, 'claude-profiles', f.attestation().generation, 'home')
  expect(await profiles.usagePreparation(f.account.id, async () => {})).toMatchObject({
    configDir: home,
    provenance: `profile:${f.account.id}`,
    envPatch: { CLAUDE_CONFIG_DIR: home }
  })
  const failed = await profiles.usagePreparation(f.account.id, async () => {
    throw new Error('private cause')
  })
  expect(failed).toMatchObject({
    configDir: '',
    provenance: `profile:${f.account.id}`,
    usageError: expect.any(String)
  })
  expect(failed?.usageError).not.toContain('private cause')
  await sources.shutdown()
})

it('enumerates ready sources without borrowing or cancelling a pending native writer', async () => {
  const f = fixture(),
    sources = new ClaudeNativeRefreshSources(f.options)
  await sources.signIn(f.account.id)
  const profiles = new ClaudeNativeSourceProfiles(f.options)
  const owner = reserveEngineWriter({
    directory: join(f.sourceRoot, 'claude-profiles', f.attestation().generation, 'writer'),
    assertExclusive: f.options.assertExclusiveProfile
  })
  expect(await sources.readyAccountIds()).toEqual(new Set([f.account.id]))
  expect(() => profiles.assertNoWriters()).toThrow()
  owner.cancelBeforeSpawn()
  await sources.shutdown()
})
