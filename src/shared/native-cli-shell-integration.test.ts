import { afterEach, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { getPosixCodexShellLaunchPreflight } from './codex-shell-function'
import { getPosixClaudeShellFunction } from './claude-shell-function'
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
it.skipIf(!existsSync('/bin/bash')).each(['claude', 'codex'] as const)(
  'routes typed %s through the host launcher with exact argv and exit code',
  async (provider) => {
    const root = mkdtempSync(join(tmpdir(), 'opka-native-shell-'))
    roots.push(root)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const executable = join(bin, provider)
    const launcher = join(bin, 'host-launcher')
    writeFileSync(executable, '#!/bin/sh\nexit 98\n')
    writeFileSync(launcher, '#!/bin/sh\nprintf "%s\\0" "$@"\nexit 37\n')
    chmodSync(executable, 0o700)
    chmodSync(launcher, 0o700)
    const fn =
      provider === 'claude' ? getPosixClaudeShellFunction() : getPosixCodexShellLaunchPreflight()
    const result = await runProcess({
      program: '/bin/bash',
      args: [
        '--noprofile',
        '--norc',
        '-c',
        `${fn}\n${provider} exec --json 'literal $text with spaces'`
      ],
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        ORCA_CODEX_ISOLATE: '0',
        ORCA_NATIVE_CLI_LAUNCHER: launcher,
        ORCA_CLAUDE_PROFILE_POINTER: join(root, 'pointer')
      }
    })
    expect(result.code).toBe(37)
    expect(result.stdout.split('\0').filter(Boolean)).toEqual([
      'agent',
      'native-exec',
      provider,
      executable,
      'exec',
      '--json',
      'literal $text with spaces'
    ])
  }
)
