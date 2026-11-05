import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it as vitestIt, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { NativeCliUserIntegrationHost } from './native-cli-user-integration-host'

const it = vitestIt.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')
const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'opka-host-install-')))
  homes.push(home)
  const dataRoot = join(home, 'host-data')
  const profileRoot = join(dataRoot, 'profiles', 'selected')
  await mkdir(profileRoot, { recursive: true })
  const commands = new Map<string, string>()
  for (const name of ['claude', 'codex', 'orca']) {
    const executable = join(home, `native-${name}`)
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    commands.set(name, executable)
  }
  const assertExclusive = vi.fn()
  const options = {
    home: () => home,
    profileRoot,
    dataRoot,
    assertExclusive,
    cliLauncher: () => commands.get('orca') ?? null,
    resolveCommands: () => commands
  }
  return { home, commands, options, service: new NativeCliUserIntegrationHost(options) }
}
it('keeps constructor and status read-only; preserves the existing bash login selection', async () => {
  const f = await fixture()
  await writeFile(join(f.home, '.profile'), '# original profile\n', { mode: 0o600 })
  await writeFile(join(f.home, '.bash_login'), '# original login\n', { mode: 0o600 })
  const before = await readdir(f.home)
  expect(f.options.assertExclusive).not.toHaveBeenCalled()
  const status = await f.service.status()
  expect(status.state).toBe('not-installed')
  expect(status.missing).toEqual([])
  expect(status.profileFiles).toContain(join(f.home, '.bash_login'))
  expect(status.profileFiles).not.toContain(join(f.home, '.bash_profile'))
  expect(await readdir(f.home)).toEqual(before)
})
it('installs and uninstalls through real profiles without creating bash_profile', async () => {
  const f = await fixture()
  const original = '# user profile\n'
  await writeFile(join(f.home, '.profile'), original, { mode: 0o600 })
  await writeFile(join(f.home, '.bash_login'), '# login\n', { mode: 0o600 })
  const installed = await f.service.install()
  expect(installed.state).toBe('installed')
  expect(await readFile(join(f.home, '.profile'), 'utf8')).toContain('Opka')
  expect(await readdir(f.home)).not.toContain('.bash_profile')
  expect(installed.binDirectory).not.toBeNull()
  if (!installed.binDirectory) {
    throw new Error('Missing installed bin')
  }
  for (const provider of ['claude', 'codex']) {
    f.commands.set(provider, join(installed.binDirectory, provider))
  }
  expect((await f.service.install()).state).toBe('installed')
  f.commands.delete('codex')
  expect((await f.service.uninstall()).state).toBe('not-installed')
  expect(await readFile(join(f.home, '.profile'), 'utf8')).toBe(original)
  expect(await readdir(f.home)).not.toContain('.bashrc')
})
it('refuses incomplete prerequisites before writing any shell profile', async () => {
  const f = await fixture()
  f.commands.delete('codex')
  expect((await f.service.status()).missing).toEqual(['codex'])
  const before = await readdir(f.home)
  await expect(f.service.install()).rejects.toThrow('both native')
  expect(await readdir(f.home)).toEqual(before)
  f.commands.delete('orca')
  expect((await f.service.status()).missing).toEqual(['codex', 'orca'])
})
it('refuses external ZDOTDIR and preserves user changes on uninstall', async () => {
  const f = await fixture()
  const external = new NativeCliUserIntegrationHost({ ...f.options, zdotdir: () => tmpdir() })
  await expect(external.install()).rejects.toThrow('inside this host user home')
  expect(await readdir(f.home)).not.toContain('.local')
  await f.service.install()
  await writeFile(join(f.home, '.profile'), '# user replaced this\n')
  expect((await f.service.status()).state).toBe('modified')
  await expect(f.service.uninstall()).rejects.toThrow()
  expect(await readFile(join(f.home, '.profile'), 'utf8')).toBe('# user replaced this\n')
})
it('bounds concurrent operations, honors cancellation, and refuses shutdown work', async () => {
  const f = await fixture()
  const aborted = AbortSignal.abort()
  await expect(f.service.install(aborted)).rejects.toThrow()
  expect(await readdir(f.home)).not.toContain('.local')
  const first = f.service.install()
  await expect(f.service.install()).rejects.toThrow('busy')
  await first
  await f.service.shutdown()
  await expect(f.service.uninstall()).rejects.toThrow('shutting down')
})

it('routes same-data-root shells through the broker while keeping account storage separate', async () => {
  const f = await fixture()
  const launcher = f.commands.get('orca'),
    native = f.commands.get('claude')
  if (!launcher || !native) {
    throw new Error('Missing fixture executables')
  }
  await writeFile(launcher, '#!/bin/sh\nprintf "broker:%s" "$ORCA_USER_DATA_PATH"\n')
  await writeFile(native, '#!/bin/sh\nprintf native\n')
  const installed = await f.service.install()
  if (!installed.binDirectory) {
    throw new Error('Missing installed bin')
  }
  const shim = join(installed.binDirectory, 'claude')
  const result = await runProcess({
    program: shim,
    args: [],
    timeoutMs: 3000,
    env: { PATH: '/usr/bin:/bin', ORCA_USER_DATA_PATH: f.options.dataRoot }
  })
  expect(result).toMatchObject({ code: 0, stdout: `broker:${f.options.dataRoot}` })
  expect(await readFile(shim, 'utf8')).not.toContain(
    `export ORCA_USER_DATA_PATH='${f.options.profileRoot}'`
  )
  const foreign = await runProcess({
    program: shim,
    args: [],
    timeoutMs: 3000,
    env: { PATH: '/usr/bin:/bin', ORCA_USER_DATA_PATH: f.home }
  })
  expect(foreign).toMatchObject({ code: 0, stdout: 'native' })
})
