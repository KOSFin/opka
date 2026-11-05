import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, expect, it } from 'vitest'
import { planNativeCliUserIntegration } from './native-cli-user-integration'
import { resolveUnwrappedNativeCliCommand } from '../../shared/native-cli-unwrapped-command'

const roots: string[] = []
const baseEnv = {
  PATH: '/usr/bin:/bin',
  ORCA_CLI_COMMAND: '',
  ORCA_NATIVE_CLI_LAUNCHER: '',
  ORCA_USER_DATA_PATH: ''
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'opka-native-context-'))
  roots.push(home)
  const binDirectory = join(home, 'managed bin')
  const userDataPath = join(home, 'profile')
  const foreignProfile = join(home, 'foreign profile')
  const cliExecutable = join(home, 'opka')
  const native = join(home, 'native')
  const foreign = join(home, 'foreign-runtime')
  for (const directory of [binDirectory, userDataPath, foreignProfile]) {
    mkdirSync(directory)
  }
  writeFileSync(cliExecutable, '#!/bin/sh\nprintf "managed:%s\\n" "$ORCA_USER_DATA_PATH"\n', {
    mode: 0o700
  })
  writeFileSync(native, '#!/bin/sh\nprintf "native:%s:%s\\n" "$ORCA_USER_DATA_PATH" "$*"\n', {
    mode: 0o700
  })
  writeFileSync(foreign, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const plan = planNativeCliUserIntegration({
    platform: 'linux',
    home,
    binDirectory,
    cliExecutable,
    userDataPath,
    nativeExecutables: { claude: native, codex: native },
    profiles: []
  })
  for (const file of plan.files) {
    writeFileSync(file.path, file.contents, { mode: file.mode })
  }
  return { home, binDirectory, userDataPath, foreignProfile, cliExecutable, native, foreign, plan }
}
const unix = process.platform === 'linux' || process.platform === 'darwin'

it.skipIf(!unix).each(['claude', 'codex'] as const)(
  'preserves a foreign Orca %s context before any routing or native probe',
  async (provider) => {
    const f = fixture()
    const result = await runProcess({
      program: '/bin/sh',
      args: [join(f.binDirectory, provider), '--version'],
      env: {
        ...baseEnv,
        ORCA_CLI_COMMAND: f.foreign,
        ORCA_USER_DATA_PATH: f.foreignProfile
      }
    })
    expect(result.stdout.trim()).toBe(`native:${f.foreignProfile}:--version`)
  }
)

it.skipIf(!unix)(
  'preserves a foreign profile even when the runtime binary is the same',
  async () => {
    const f = fixture()
    const result = await runProcess({
      program: '/bin/sh',
      args: [join(f.binDirectory, 'claude'), '-p', 'synthetic'],
      env: {
        ...baseEnv,
        ORCA_CLI_COMMAND: f.cliExecutable,
        ORCA_USER_DATA_PATH: f.foreignProfile
      }
    })
    expect(result.stdout.trim()).toBe(`native:${f.foreignProfile}:-p synthetic`)
  }
)

it.skipIf(!unix)(
  'recognizes the configured runtime and profile through filesystem aliases',
  async () => {
    const f = fixture()
    const command = join(f.home, 'runtime-alias'),
      profile = join(f.home, 'profile-alias')
    symlinkSync(f.cliExecutable, command)
    symlinkSync(f.userDataPath, profile)
    const result = await runProcess({
      program: '/bin/sh',
      args: [join(f.binDirectory, 'claude'), '-p', 'synthetic'],
      env: { ...baseEnv, ORCA_CLI_COMMAND: command, ORCA_USER_DATA_PATH: profile }
    })
    expect(result.stdout.trim()).toBe(`managed:${f.userDataPath}`)
    expect(resolveUnwrappedNativeCliCommand('claude', join(f.binDirectory, 'claude'))).toBe(
      f.native
    )
  }
)

it.skipIf(!unix)(
  'routes ordinary terminals without an Orca context to the configured profile',
  async () => {
    const f = fixture()
    const result = await runProcess({
      program: '/bin/sh',
      args: [join(f.binDirectory, 'codex')],
      env: { ...baseEnv }
    })
    expect(result.stdout.trim()).toBe(`managed:${f.userDataPath}`)
  }
)

it('preserves manifest ownership and refuses modified or unverified launchers', () => {
  const f = fixture()
  const manifest = f.plan.files.at(-1)
  if (!manifest) {
    throw new Error('Missing manifest')
  }
  expect(manifest.mode).toBe(0o600)
  expect(manifest.expectedSha256).toBeNull()
  const common = {
    platform: 'linux' as const,
    home: f.home,
    binDirectory: f.binDirectory,
    cliExecutable: f.cliExecutable,
    userDataPath: f.userDataPath,
    nativeExecutables: { claude: f.native, codex: f.native },
    profiles: [],
    previousManifest: manifest.contents
  }
  const updated = planNativeCliUserIntegration(common)
  expect(updated.files.at(-1)?.expectedSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(updated.files.at(-1)?.backupRequired).toBe(true)
  expect(() => planNativeCliUserIntegration({ ...common, previousManifest: '' })).toThrow(
    'unverified'
  )
  expect(() =>
    planNativeCliUserIntegration({
      ...common,
      previousShims: {
        claude: '#!/bin/sh\n# Opka native account launcher v1\nuser-customization\n'
      }
    })
  ).toThrow('modified')
})
