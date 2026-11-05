import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { installClaudeNativeCoverageModule } from './claude-native-coverage-install'

const enabled = process.platform === 'linux' && process.env.OPKA_SYNTHETIC_LOOPBACK_SCOPE === '1'
it.skipIf(!enabled)(
  'accepts the production module through exact native offline plugin validation',
  async () => {
    const executable = process.env.OPKA_SYNTHETIC_CLAUDE_BINARY
    if (!executable) {
      throw new Error('An explicit qualified native executable is required.')
    }
    const root = await mkdtemp(join(tmpdir(), 'opka-native-module-validation-'))
    let code: number | null = null,
      passed = false
    try {
      const directory = installClaudeNativeCoverageModule({
        home: root,
        launchId: '11111111-1111-4111-8111-111111111111',
        launch: { command: process.execPath, args: ['/synthetic-CLI-not-executed.js'] },
        assertExclusive: () => {}
      })
      const result = await runProcess({
        program: executable,
        args: ['plugin', 'validate', directory],
        cwd: root,
        env: {
          HOME: root,
          CLAUDE_CONFIG_DIR: root,
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1'
        },
        timeoutMs: 10000,
        maxOutputBytes: 128 * 1024
      })
      code = result.code
      passed = /Validation passed/i.test(result.stdout + result.stderr)
      expect(code, result.stdout + result.stderr).toBe(0)
      expect(passed).toBe(true)
    } finally {
      if (process.env.OPKA_NATIVE_MOD_VALIDATION_RECEIPT) {
        await writeFile(
          process.env.OPKA_NATIVE_MOD_VALIDATION_RECEIPT,
          JSON.stringify({ code, passed }),
          { mode: 0o600 }
        )
      }
      await rm(root, { recursive: true, force: true })
    }
  },
  15000
)
