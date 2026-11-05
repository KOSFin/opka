import { runProcess } from '@orca/process-host'
import { createRequire } from 'node:module'
import process from 'node:process'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { probeDarwinRefreshSecurity } from './claude-native-darwin-security-probe.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDarwinNativeProbeCi } from './claude-native-probe-cli.mjs'
import { runDarwinNativeRefreshQualification } from './claude-native-darwin-refresh.mjs'
import { createDarwinRefreshServer } from './claude-native-darwin-refresh-server.mjs'

const skip = isDarwinNativeProbeCi()
test(
  'refresh qualification refuses outside isolated Darwin CI before reading paths',
  { skip },
  async () => {
    await assert.rejects(runDarwinNativeRefreshQualification({}), /isolated Darwin CI/)
  }
)
test('TLS setup refuses outside isolated Darwin CI before writing files', { skip }, async () => {
  await assert.rejects(createDarwinRefreshServer(undefined), /isolated Darwin CI/)
})

test(
  'OS Security preflight refuses outside isolated Darwin CI without spawning security',
  { skip },
  async () => {
    await assert.rejects(probeDarwinRefreshSecurity({}), /isolated Darwin CI/)
  }
)

test('refresh fixture closure has no unresolved runtime identifiers', async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const require = createRequire(import.meta.url)
  const linter = join(dirname(require.resolve('oxlint/package.json')), 'bin', 'oxlint')
  const result = await runProcess({
    program: process.execPath,
    args: [
      linter,
      '--deny',
      'no-undef',
      'config/scripts/claude-native-darwin-refresh.mjs',
      'config/scripts/claude-native-darwin-security-probe.mjs',
      'config/scripts/claude-native-darwin-security-shim.mjs',
      'config/scripts/claude-native-darwin-security-shim-runner.mjs',
      'config/scripts/claude-native-darwin-security-write-probe.mjs',
      'config/scripts/claude-native-darwin-keychain-domain.mjs',
      'config/scripts/claude-native-darwin-refresh-preflight.mjs',
      'config/scripts/claude-native-darwin-refresh-cache.mjs',
      'config/scripts/claude-native-darwin-refresh-writer.mjs'
    ],
    cwd: root,
    timeoutMs: 10000,
    maxOutputBytes: 4096,
    terminationBarrier: true
  })
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.equal(result.timedOut, false)
  assert.equal(result.outputTruncated, false)
})
