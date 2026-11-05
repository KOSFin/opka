import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runProcess } from '@orca/process-host'
import { afterEach, expect, it as vitestIt } from 'vitest'
import { planNativeCliUserIntegration } from './native-cli-user-integration'

const it = vitestIt.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')
const homes: string[] = []
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })))
it.each(['profile-tail', 'noninteractive-bash-return'])(
  'keeps the owned command first after %s without duplicate PATH entries',
  async (scenario) => {
    const home = mkdtempSync(join(tmpdir(), 'opka-path-order-'))
    homes.push(home)
    const bin = join(home, 'managed bin'),
      native = join(home, 'native')
    mkdirSync(bin)
    mkdirSync(native)
    for (const provider of ['claude', 'codex']) {
      writeFileSync(join(native, provider), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    }
    const bash = scenario === 'noninteractive-bash-return'
    const profile = join(home, bash ? '.bashrc' : '.profile')
    const original = `${bash ? 'case $- in *i*) ;; *) return;; esac\n' : ''}PATH="$HOME/native:/usr/bin:/bin"\n`
    const plan = planNativeCliUserIntegration({
      platform: process.platform,
      home,
      binDirectory: bin,
      cliExecutable: join(home, 'opka'),
      userDataPath: join(home, 'profile'),
      nativeExecutables: { claude: join(native, 'claude'), codex: join(native, 'codex') },
      profiles: [{ path: profile, contents: original, mode: 0o600 }]
    })
    for (const file of plan.files) {
      writeFileSync(file.path, file.contents, { mode: file.mode })
    }
    const result = await runProcess({
      program: bash ? '/bin/bash' : '/bin/sh',
      args: [
        ...(bash ? ['--noprofile', '--norc'] : []),
        '-c',
        '. "$1"; printf "%s\\n" "$PATH"; command -v codex',
        'opka-path-test',
        profile
      ],
      env: { HOME: home, PATH: `${native}:${bin}:${bin}:/usr/bin:/bin` },
      timeoutMs: 3000
    })
    expect(result.code).toBe(0)
    const [path, command] = result.stdout.trim().split('\n')
    expect(path?.split(':')[0]).toBe(bin)
    expect(path?.split(':').filter((entry) => entry === bin)).toHaveLength(1)
    expect(command).toBe(join(bin, 'codex'))
  }
)
