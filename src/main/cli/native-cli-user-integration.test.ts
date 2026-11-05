import { expect, it as vitestIt } from 'vitest'
import { planNativeCliUserIntegration } from './native-cli-user-integration'
const it = vitestIt.skipIf(process.platform === 'win32')
const options = {
  platform: 'linux' as const,
  home: '/home/user',
  binDirectory: '/home/user/.local/share/opka/bin',
  cliExecutable: '/opt/opka/current/bin/opka',
  userDataPath: '/home/user/.local/share/opka/runtime',
  nativeExecutables: { claude: '/home/user/.npm/bin/claude', codex: '/home/user/.npm/bin/codex' },
  profiles: [
    {
      path: '/home/user/.bashrc',
      contents: 'case $- in *i*) ;; *) return;; esac\n# user configuration\n',
      mode: 0o600
    }
  ]
}
it('stages executable user shims while leaving native npm binaries untouched', () => {
  const plan = planNativeCliUserIntegration(options)
  expect(plan.files.map((f) => f.path)).toEqual([
    '/home/user/.local/share/opka/bin/claude',
    '/home/user/.local/share/opka/bin/codex',
    '/home/user/.bashrc',
    '/home/user/.local/share/opka/bin/.opka-native-cli.json'
  ])
  expect(plan.files[0]?.contents).toContain(
    "exec '/opt/opka/current/bin/opka' agent native-exec claude '/home/user/.npm/bin/claude' \"$@\""
  )
  expect(plan.files[0]?.mode).toBe(0o700)
  expect(plan.files[2]?.mode).toBe(0o600)
})
it('prepends PATH before the bash noninteractive return guard and preserves rollback evidence', () => {
  const plan = planNativeCliUserIntegration(options)
  expect(plan.files[2]?.contents).toContain(options.profiles[0].contents)
  expect(plan.files[2]?.contents.indexOf('export PATH')).toBeLessThan(
    plan.files[2]!.contents.indexOf('return')
  )
  expect(plan.files[2]?.expectedSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(plan.uninstall[2]).toMatchObject({ restoreBackup: true })
})
it('updates only one owned block without duplicating PATH entries', () => {
  const first = planNativeCliUserIntegration(options)
  const second = planNativeCliUserIntegration({
    ...options,
    profiles: [{ ...options.profiles[0], contents: first.files[2]!.contents }]
  })
  expect(second.files[2]?.contents).toBe(first.files[2]?.contents)
})
it('refuses recursive executable paths, foreign executables and unsupported platforms', () => {
  expect(() =>
    planNativeCliUserIntegration({
      ...options,
      nativeExecutables: {
        ...options.nativeExecutables,
        codex: '/home/user/.local/share/opka/bin/codex'
      }
    })
  ).toThrow('outside')
  expect(() =>
    planNativeCliUserIntegration({
      ...options,
      previousShims: { codex: '#!/bin/sh\nuser script\n' }
    })
  ).toThrow('not owned')
  expect(() => planNativeCliUserIntegration({ ...options, platform: 'win32' })).toThrow('Unix')
})
it('refuses incomplete managed profile markers instead of discarding user configuration', () => {
  expect(() =>
    planNativeCliUserIntegration({
      ...options,
      profiles: [
        {
          ...options.profiles[0],
          contents: '# >>> Opka native account launchers >>>\n# user configuration\n'
        }
      ]
    })
  ).toThrow('incomplete')
})
