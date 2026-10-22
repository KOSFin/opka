import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readRemoteAcceptanceConfig } from './fork-acceptance-remote-config.mjs'

test('remote acceptance has no implicit host, account or key', () => {
  assert.throws(
    () => readRemoteAcceptanceConfig({}, join(tmpdir(), 'missing-opka-config')),
    /Explicit isolated/
  )
})

test('explicit env overrides local config without reading the key', () => {
  const area = mkdtempSync(join(tmpdir(), 'opka-remote-config-'))
  try {
    const filename = join(area, 'remote.json')
    const local = {
      host: 'fixture.invalid',
      username: 'fixture',
      identityFile: join(area, 'nonexistent-key'),
      remoteRoot: '/srv/opka-fixture'
    }
    writeFileSync(filename, JSON.stringify(local), { mode: 0o600 })
    assert.deepEqual(readRemoteAcceptanceConfig({}, filename), local)
    assert.equal(
      readRemoteAcceptanceConfig({ ORCA_FORK_AUDIT_SSH_HOST: 'override.invalid' }, filename).host,
      'override.invalid'
    )
    for (const remoteRoot of ['/', '/srv/../', '/srv/fixture;echo', 'relative']) {
      assert.throws(
        () => readRemoteAcceptanceConfig({ ORCA_FORK_AUDIT_REMOTE_ROOT: remoteRoot }, filename),
        /Explicit isolated/
      )
    }
    assert.throws(
      () =>
        readRemoteAcceptanceConfig({ ORCA_FORK_AUDIT_SSH_HOST: '-oProxyCommand=unsafe' }, filename),
      /Explicit isolated/
    )
  } finally {
    rmSync(area, { recursive: true, force: true })
  }
})
