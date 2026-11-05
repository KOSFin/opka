import { afterEach, expect, it as vitestIt, vi } from 'vitest'
import { mkdtemp, realpath, writeFile, readFile, lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as Fs from 'node:fs/promises'
const race = vi.hoisted(() => ({
  backup: '',
  reads: 0,
  remove: false,
  failAt: '',
  publication: '',
  userInode: ''
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (args[0] === race.backup && ++race.reads === 4) {
        await (race.remove
          ? actual.unlink(race.backup)
          : actual.writeFile(race.backup, '# backup edited between reads\n', { mode: 0o600 }))
      }
      return actual.lstat(...args)
    },
    rename: async (
      from: Parameters<typeof actual.rename>[0],
      to: Parameters<typeof actual.rename>[1]
    ) => {
      if (from === race.failAt) {
        race.failAt = ''
        const bytes = await actual.readFile(race.publication)
        await actual.rename(race.publication, `${race.publication}.user-held`)
        await actual.writeFile(race.publication, bytes, { mode: 0o700, flag: 'wx' })
        race.userInode = (await actual.lstat(race.publication, { bigint: true })).ino.toString()
        throw new Error('synthetic later-publication failure')
      }
      return actual.rename(from, to)
    }
  }
})
import { planNativeCliUserIntegration } from './native-cli-user-integration'
import {
  applyNativeCliUserIntegration,
  rollbackNativeCliUserIntegration
} from './native-cli-user-installation'
const it = vitestIt.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')
const roots: string[] = []
afterEach(async () => {
  race.backup = ''
  race.reads = 0
  race.remove = false
  race.failAt = ''
  race.publication = ''
  race.userInode = ''
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'opka-user-install-cas-')))
  roots.push(home)
  const profile = join(home, '.bashrc'),
    binDirectory = join(home, 'bin'),
    stateDirectory = join(home, 'state')
  await writeFile(profile, '# original personal settings\n', { mode: 0o644 })
  const plan = planNativeCliUserIntegration({
    platform: process.platform,
    home,
    binDirectory,
    cliExecutable: join(home, 'opka'),
    userDataPath: join(home, 'data'),
    nativeExecutables: { claude: join(home, 'native-claude'), codex: join(home, 'native-codex') },
    profiles: [{ path: profile, contents: '# original personal settings\n', mode: 0o644 }]
  })
  return {
    profile,
    binDirectory,
    stateDirectory,
    plan,
    options: { home, stateDirectory, assertExclusive: () => {} }
  }
}
it.each(['deleted', 'edited'] as const)(
  'refuses a backup %s after initial validation before any uninstall mutation',
  async (scenario) => {
    const f = await fixture()
    await applyNativeCliUserIntegration({ ...f.options, plan: f.plan })
    const profile = await readFile(f.profile)
    const shim = await readFile(join(f.binDirectory, 'claude'))
    race.backup = join(f.stateDirectory, 'original-2')
    race.remove = scenario === 'deleted'
    await expect(rollbackNativeCliUserIntegration(f.options)).rejects.toThrow(
      /original backup changed/
    )
    expect(await readFile(f.profile)).toEqual(profile)
    expect(await readFile(join(f.binDirectory, 'claude'))).toEqual(shim)
    expect(await readdir(f.stateDirectory)).not.toContain('pending')
  }
)
it('never overwrites a user replacement with identical published bytes during failed-transaction recovery', async () => {
  const f = await fixture()
  race.failAt = f.profile
  race.publication = join(f.binDirectory, 'claude')
  await expect(applyNativeCliUserIntegration({ ...f.options, plan: f.plan })).rejects.toThrow(
    /pending evidence/
  )
  expect((await lstat(race.publication, { bigint: true })).ino.toString()).toBe(race.userInode)
  expect(await readFile(race.publication)).toEqual(await readFile(`${race.publication}.user-held`))
  expect(await readFile(f.profile, 'utf8')).toBe('# original personal settings\n')
  expect(await readdir(f.binDirectory)).not.toContain('codex')
  expect(await readdir(f.stateDirectory)).toContain('pending')
})
