import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildProfileCliLauncher, ProfileCliRegistration } from './profile-cli-registration'

const roots: string[] = []
const unix = it.skipIf(process.platform === 'win32')
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-profile-cli-'))
  roots.push(root)
  const profile = join(root, 'profile with spaces')
  const resources = join(root, 'resources')
  await mkdir(join(resources, 'bin'), { recursive: true })
  await writeFile(join(resources, 'bin', 'orca'), '#!/bin/sh\n', { mode: 0o700 })
  return {
    profile,
    resources,
    registration: new ProfileCliRegistration(profile, resources, 'darwin')
  }
}
unix('registers Opka beside the isolated legacy test command without touching it', async () => {
  const { profile, resources, registration } = await fixture()
  await registration.install()
  const legacyPath = join(profile, 'cli', 'bin', 'orca-fork')
  const previous = await readFile(legacyPath, 'utf8')
  const opka = new ProfileCliRegistration(profile, resources, 'darwin', 'opka')
  expect((await opka.install()).commandName).toBe('opka')
  expect((await opka.getStatus()).commandPath).toBe(join(profile, 'cli', 'bin', 'opka'))
  await opka.remove()
  expect(await readFile(legacyPath, 'utf8')).toBe(previous)
  expect(() => new ProfileCliRegistration(profile, resources, 'darwin', '../orca')).toThrow()
})
unix('creates and removes only a private profile command, idempotently', async () => {
  const { registration, profile } = await fixture()
  expect((await registration.getStatus()).state).toBe('not_installed')
  const installed = await registration.install()
  expect(installed.state).toBe('installed')
  expect(installed.registrationScope).toBe('profile')
  expect(installed.pathConfigured).toBe(false)
  expect(installed.commandPath).toBe(join(profile, 'cli', 'bin', 'orca-fork'))
  expect((await registration.install()).state).toBe('installed')
  expect(await readFile(join(profile, 'cli', 'bin', 'orca-fork'), 'utf8')).toContain(
    'ORCA_USER_DATA_PATH='
  )
  expect((await registration.remove()).state).toBe('not_installed')
})
unix('refuses foreign files and symlinks without replacing or deleting them', async () => {
  const { registration, profile } = await fixture()
  const command = join(profile, 'cli', 'bin', 'orca-fork')
  await mkdir(join(profile, 'cli', 'bin'), { recursive: true })
  await writeFile(command, 'foreign')
  expect((await registration.install()).state).toBe('conflict')
  expect((await registration.remove()).state).toBe('conflict')
  expect(await readFile(command, 'utf8')).toBe('foreign')
  await rm(command)
  await symlink('/nonexistent', command)
  expect((await registration.install()).state).toBe('conflict')
  expect((await registration.remove()).state).toBe('conflict')
})
unix('reports a missing packaged launcher without writing a command', async () => {
  const { profile } = await fixture()
  const registration = new ProfileCliRegistration(profile, join(profile, 'missing'), 'linux')
  expect((await registration.install()).state).toBe('unsupported')
})
unix('does not follow a symlinked command directory', async () => {
  const { registration, profile, resources } = await fixture()
  await mkdir(profile, { recursive: true })
  await symlink(resources, join(profile, 'cli'))
  expect((await registration.install()).state).toBe('conflict')
  expect((await registration.remove()).state).toBe('conflict')
})
unix('repairs executable permission only for the exact owned wrapper', async () => {
  const { registration, profile } = await fixture()
  await registration.install()
  await chmod(join(profile, 'cli', 'bin', 'orca-fork'), 0o600)
  expect((await registration.getStatus()).state).toBe('stale')
  expect((await registration.install()).state).toBe('installed')
})
it('quotes profile paths and isolates account-home overrides on Unix and Windows', () => {
  const unix = buildProfileCliLauncher('linux', '/tmp/it\u0027s profile', '/app/bin/orca-ide')
  expect(unix).toContain('unset CODEX_HOME ORCA_CODEX_HOME CLAUDE_CONFIG_DIR')
  expect(unix).toContain('ORCA_PAIRING_CODE ORCA_REMOTE_PAIRING ORCA_ENVIRONMENT ORCA_OPEN_COMMAND')
  expect(unix).toContain('exec \'/app/bin/orca-ide\' "$@"')
  const windows = buildProfileCliLauncher('win32', 'C:\\a%TEMP%\\profile', 'C:\\Orca\\orca.exe')
  expect(windows).toContain('a%%TEMP%%')
  expect(windows).toContain('set "CODEX_HOME="')
  expect(windows).toContain('"C:\\Orca\\orca.exe" %*')
})
it('uses a profile-owned CMD forwarder for Windows without PATH registration', async () => {
  const { profile, resources } = await fixture()
  await writeFile(join(resources, 'bin', 'orca.exe'), 'fixture')
  const registration = new ProfileCliRegistration(profile, resources, 'win32')
  const status = await registration.install()
  expect(status.state).toBe('installed')
  expect(status.pathConfigured).toBe(false)
  expect(status.commandPath).toBe(join(profile, 'cli', 'bin', 'orca-fork.cmd'))
  expect(await readFile(join(profile, 'cli', 'bin', 'orca-fork.cmd'), 'utf8')).toContain(
    '@echo off'
  )
  expect((await registration.remove()).state).toBe('not_installed')
})
