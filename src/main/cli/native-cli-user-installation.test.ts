import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it as vitestIt } from 'vitest'
import { planNativeCliUserIntegration } from './native-cli-user-integration'
import {
  applyNativeCliUserIntegration,
  rollbackNativeCliUserIntegration
} from './native-cli-user-installation'
import { resolveUnwrappedNativeCliCommand } from '../../shared/native-cli-unwrapped-command'
const it = vitestIt.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')
const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true })
  }
})
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'opka-user-install-')))
  homes.push(home)
  const binDirectory = join(home, 'managed bin'),
    stateDirectory = join(home, 'private-state')
  const profile = join(home, '.bashrc'),
    native = join(home, 'native-claude'),
    codex = join(home, 'native-codex')
  const original = '# user configuration\ncase $- in *i*) ;; *) return;; esac\n'
  await writeFile(profile, original, { mode: 0o644 })
  await writeFile(native, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await writeFile(codex, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const options = { home, stateDirectory, assertExclusive: () => {} }
  async function plan(cli = join(home, 'opka')) {
    const previous = async (path: string) => {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return undefined
        }
        throw error
      }
    }
    return planNativeCliUserIntegration({
      platform: process.platform,
      home,
      binDirectory,
      cliExecutable: cli,
      userDataPath: join(home, 'data'),
      nativeExecutables: { claude: native, codex },
      profiles: [
        {
          path: profile,
          contents: await readFile(profile, 'utf8'),
          mode: (await lstat(profile)).mode & 0o777
        }
      ],
      previousShims: {
        claude: await previous(join(binDirectory, 'claude')),
        codex: await previous(join(binDirectory, 'codex'))
      },
      previousManifest: await previous(join(binDirectory, '.opka-native-cli.json'))
    })
  }
  return { home, profile, original, binDirectory, stateDirectory, native, codex, options, plan }
}
it('applies real user files with private immutable backups and restores the original byte-for-byte', async () => {
  const f = await fixture(),
    plan = await f.plan()
  const nativeBefore = await readFile(f.native)
  expect(await applyNativeCliUserIntegration({ ...f.options, plan })).toEqual({ changed: true })
  expect((await lstat(join(f.binDirectory, 'claude'))).mode & 0o777).toBe(0o700)
  expect((await lstat(join(f.binDirectory, '.opka-native-cli.json'))).mode & 0o777).toBe(0o600)
  expect((await lstat(f.stateDirectory)).mode & 0o777).toBe(0o700)
  expect((await lstat(join(f.stateDirectory, 'original-2'))).mode & 0o777).toBe(0o600)
  expect(resolveUnwrappedNativeCliCommand('claude', join(f.binDirectory, 'claude'))).toBe(f.native)
  expect(await readFile(f.native)).toEqual(nativeBefore)
  expect((await readFile(f.profile, 'utf8')).indexOf('export PATH')).toBeLessThan(
    (await readFile(f.profile, 'utf8')).indexOf('return')
  )
  expect(await rollbackNativeCliUserIntegration(f.options)).toEqual({ changed: true })
  expect(await readFile(f.profile, 'utf8')).toBe(f.original)
  expect((await lstat(f.profile)).mode & 0o777).toBe(0o644)
  expect(await readdir(f.binDirectory)).toEqual([])
  expect(await readdir(f.stateDirectory)).toEqual([])
})
it('keeps ORIGINAL rollback data bounded across repeated apply and upgrades', async () => {
  const f = await fixture(),
    first = await f.plan()
  await applyNativeCliUserIntegration({ ...f.options, plan: first })
  const backup = await readFile(join(f.stateDirectory, 'original-2'))
  expect(await applyNativeCliUserIntegration({ ...f.options, plan: first })).toEqual({
    changed: false
  })
  for (let index = 0; index < 8; index++) {
    await applyNativeCliUserIntegration({
      ...f.options,
      plan: await f.plan(join(f.home, `opka-${index}`))
    })
  }
  expect((await readdir(f.stateDirectory)).sort()).toEqual(['original-2', 'receipt.json'])
  expect(await readFile(join(f.stateDirectory, 'original-2'))).toEqual(backup)
  await rollbackNativeCliUserIntegration(f.options)
  expect(await readFile(f.profile, 'utf8')).toBe(f.original)
})
it('refuses a stale staged plan before changing any user file', async () => {
  const f = await fixture(),
    plan = await f.plan()
  await writeFile(f.profile, '# changed by user\n')
  await expect(applyNativeCliUserIntegration({ ...f.options, plan })).rejects.toThrow(/stale/)
  expect(await readFile(f.profile, 'utf8')).toBe('# changed by user\n')
  expect(await readdir(f.binDirectory)).toEqual([])
})
it('preserves edited or replaced installed profiles and their original backup on uninstall', async () => {
  const f = await fixture()
  await applyNativeCliUserIntegration({ ...f.options, plan: await f.plan() })
  const installed = await readFile(f.profile, 'utf8')
  await unlink(f.profile)
  await writeFile(f.profile, installed, { mode: 0o644 })
  await expect(rollbackNativeCliUserIntegration(f.options)).rejects.toThrow(/User changes/)
  expect(await readFile(f.profile, 'utf8')).toBe(installed)
  expect(await readFile(join(f.stateDirectory, 'original-2'), 'utf8')).toBe(f.original)
  await writeFile(f.profile, `${installed}# new personal settings\n`)
  await expect(
    applyNativeCliUserIntegration({ ...f.options, plan: await f.plan() })
  ).rejects.toThrow(/User changes/)
  expect(await readFile(f.profile, 'utf8')).toContain('# new personal settings')
})
it('refuses symlink and hardlink targets without touching their other user files', async () => {
  const f = await fixture(),
    plan = await f.plan(),
    other = join(f.home, 'other')
  await writeFile(other, f.original, { mode: 0o644 })
  await unlink(f.profile)
  await symlink(other, f.profile)
  await expect(applyNativeCliUserIntegration({ ...f.options, plan })).rejects.toThrow(/regular/)
  expect(await readFile(other, 'utf8')).toBe(f.original)
  await unlink(f.profile)
  await link(other, f.profile)
  await expect(applyNativeCliUserIntegration({ ...f.options, plan })).rejects.toThrow(/regular/)
  expect(await readFile(other, 'utf8')).toBe(f.original)
})
it('refuses writable-parent symlinks and read-only Unix files rather than changing permissions', async () => {
  const f = await fixture(),
    plan = await f.plan(),
    foreign = join(f.home, 'foreign-bin')
  await mkdir(foreign)
  await symlink(foreign, f.binDirectory)
  await expect(applyNativeCliUserIntegration({ ...f.options, plan })).rejects.toThrow(/symlinks/)
  expect(await readdir(foreign)).toEqual([])
  await unlink(f.binDirectory)
  await chmod(f.profile, 0o444)
  await expect(applyNativeCliUserIntegration({ ...f.options, plan })).rejects.toThrow(/regular/)
  expect((await lstat(f.profile)).mode & 0o777).toBe(0o444)
})
it('preserves pending crash evidence and tampered private backups without starting another transaction', async () => {
  const f = await fixture()
  await applyNativeCliUserIntegration({ ...f.options, plan: await f.plan() })
  const before = await readFile(f.profile)
  await mkdir(join(f.stateDirectory, 'pending'), { mode: 0o700 })
  await expect(rollbackNativeCliUserIntegration(f.options)).rejects.toThrow(/recovery is pending/)
  expect(await readFile(f.profile)).toEqual(before)
  await rm(join(f.stateDirectory, 'pending'), { recursive: true })
  await writeFile(join(f.stateDirectory, 'original-2'), 'tampered')
  await expect(rollbackNativeCliUserIntegration(f.options)).rejects.toThrow(/unverifiable/)
  expect(await readFile(f.profile)).toEqual(before)
})
it('rejects arbitrary out-of-home or private-state targets even in a forged source plan', async () => {
  const f = await fixture(),
    plan = await f.plan()
  const target = plan.files.find((file) => file.path === f.profile)
  if (!target) {
    throw new Error('Missing staged profile')
  }
  target.path = join(f.stateDirectory, '.bashrc')
  await expect(applyNativeCliUserIntegration({ ...f.options, plan })).rejects.toThrow(
    /shell profiles/
  )
  target.path = join(f.home, '..', '.bashrc')
  await expect(applyNativeCliUserIntegration({ ...f.options, plan })).rejects.toThrow(
    /plan is invalid/
  )
  expect(await readFile(f.profile, 'utf8')).toBe(f.original)
})
