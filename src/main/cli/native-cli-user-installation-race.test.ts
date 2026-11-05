import { afterEach, expect, it as vitestIt, vi } from 'vitest'
import { mkdtemp, realpath, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as Fs from 'node:fs/promises'
const race = vi.hoisted(() => ({ path: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  return {
    ...actual,
    rename: async (
      from: Parameters<typeof actual.rename>[0],
      to: Parameters<typeof actual.rename>[1]
    ) => {
      if (from === race.path) {
        race.path = ''
        await actual.unlink(from)
        await actual.writeFile(from, '# concurrent personal settings\n', { mode: 0o644 })
      }
      return actual.rename(from, to)
    }
  }
})
import { planNativeCliUserIntegration } from './native-cli-user-integration'
import { applyNativeCliUserIntegration } from './native-cli-user-installation'
const it = vitestIt.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')
const roots: string[] = []
afterEach(async () => {
  race.path = ''
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
it('restores a concurrently replaced user entry, undoes other publications, and retains bounded pending evidence', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'opka-user-install-race-')))
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
  race.path = profile
  await expect(
    applyNativeCliUserIntegration({ home, stateDirectory, plan, assertExclusive: () => {} })
  ).rejects.toThrow(/pending evidence/)
  expect(await readFile(profile, 'utf8')).toBe('# concurrent personal settings\n')
  expect(await readdir(binDirectory)).toEqual([])
  expect((await readdir(stateDirectory)).sort()).toEqual(['original-2', 'pending'])
  expect(await readFile(join(stateDirectory, 'original-2'), 'utf8')).toBe(
    '# original personal settings\n'
  )
  await expect(
    applyNativeCliUserIntegration({ home, stateDirectory, plan, assertExclusive: () => {} })
  ).rejects.toThrow(/recovery is pending/)
  expect((await readdir(stateDirectory)).sort()).toEqual(['original-2', 'pending'])
})
