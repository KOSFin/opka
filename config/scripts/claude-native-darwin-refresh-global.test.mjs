import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  prepareDarwinRefreshGlobalSentinels,
  assertDarwinRefreshKeychainSelection,
  assertDarwinRefreshFileUnchanged
} from './claude-native-darwin-refresh-global.mjs'

async function fixture(run) {
  const home = await mkdtemp(join(tmpdir(), 'opka-fake-global-'))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
test('fake global sentinels detect mutation and preserve the evidence', () =>
  fixture(async (home) => {
    const guard = await prepareDarwinRefreshGlobalSentinels(home)
    await guard.assertUnchanged()
    const file = join(home, '.claude', '.credentials.json')
    await writeFile(file, 'changed')
    let changed
    await assert.rejects(
      guard.assertUnchanged((value) => {
        changed = value
      }),
      /changed global/
    )
    assert.deepEqual(changed, { state: false, credentials: true, settings: false })
    await assert.rejects(guard.dispose(), /cleanup is unverified/)
    assert.equal(await readFile(file, 'utf8'), 'changed')
  }))
test('existing fake host files remain exact and only created sentinels are removed', () =>
  fixture(async (home) => {
    const file = join(home, '.claude.json')
    await writeFile(file, '{"existing":true}')
    const original = await lstat(file)
    const guard = await prepareDarwinRefreshGlobalSentinels(home)
    await guard.assertUnchanged()
    await guard.dispose()
    assert.equal(await readFile(file, 'utf8'), '{"existing":true}')
    assert.equal((await lstat(file)).ino, original.ino)
    await assert.rejects(readFile(join(home, '.claude', '.credentials.json')), { code: 'ENOENT' })
  }))
test('global directory symlinks are refused before writing', () =>
  fixture(async (home) => {
    const target = join(home, 'target')
    await mkdir(target)
    await symlink(target, join(home, '.claude'))
    await assert.rejects(prepareDarwinRefreshGlobalSentinels(home), /unverified/)
    await assert.rejects(readFile(join(target, '.credentials.json')), { code: 'ENOENT' })
  }))
test('only refreshed Keychain A with untouched adversarial file B qualifies', () => {
  const selected = { source: 'scoped-keychain', nativeAccess: { accessToken: 'fresh-A' } }
  const file = { refreshToken: 'file-B' }
  assertDarwinRefreshKeychainSelection(selected, file, {
    freshAccess: 'fresh-A',
    fileRefresh: 'file-B'
  })
  for (const source of ['keychain', 'legacy-keychain', 'credentials-file', 'none']) {
    assert.throws(() =>
      assertDarwinRefreshKeychainSelection({ ...selected, source }, file, {
        freshAccess: 'fresh-A',
        fileRefresh: 'file-B'
      })
    )
  }
  assert.throws(() =>
    assertDarwinRefreshKeychainSelection(
      selected,
      { refreshToken: 'rotated-A' },
      { freshAccess: 'fresh-A', fileRefresh: 'file-B' }
    )
  )
})

test('same refresh token and footprint cannot conceal changed file access bytes', () =>
  fixture(async (home) => {
    const file = join(home, 'credentials.json')
    const expected = '{"accessToken":"old-B","refreshToken":"file-B"}'
    await writeFile(file, expected)
    await assertDarwinRefreshFileUnchanged(file, expected)
    await writeFile(file, expected.replace('old-B', 'new-A'))
    await assert.rejects(
      assertDarwinRefreshFileUnchanged(file, expected),
      /changed the adversarial/
    )
  }))

test('format-only source rewrite is classified but still fails the exact-byte guard', () =>
  fixture(async (home) => {
    const file = join(home, 'credentials.json')
    const expected = '{"claudeAiOauth":{"accessToken":"B","refreshToken":"B"}}'
    await writeFile(file, JSON.stringify(JSON.parse(expected), null, 2))
    let difference
    await assert.rejects(
      assertDarwinRefreshFileUnchanged(file, expected, (value) => {
        difference = value
      }),
      /changed the adversarial/
    )
    assert.equal(difference.bytesEqual, false)
    assert.equal(difference.jsonEquivalent, true)
    assert.equal(difference.accessEqual, true)
    assert.equal(difference.refreshEqual, true)
  }))
