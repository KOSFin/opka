import { runProcess } from '@orca/process-host'
import { isDarwinNativeProbeCi } from './claude-native-probe-cli.mjs'

/** A missing fake item tests OS lookup access without requesting a password or inventory. */
export async function probeDarwinRefreshSecurity({ sandbox, keychain, env }) {
  if (!isDarwinNativeProbeCi()) {
    throw new Error('Security preflight requires isolated Darwin CI')
  }
  const observations = []
  for (const sandboxed of [false, true]) {
    for (const explicit of [false, true]) {
      const args = ['find-generic-password', '-s', 'opka-fake-refresh-absence-probe']
      if (explicit) {
        args.push(keychain)
      }
      const result = await runProcess({
        program: sandboxed ? '/usr/bin/sandbox-exec' : '/usr/bin/security',
        args: sandboxed ? ['-f', sandbox, '/usr/bin/security', ...args] : args,
        env,
        timeoutMs: 2000,
        maxOutputBytes: 256,
        terminationBarrier: true
      })
      observations.push({
        sandboxed,
        explicit,
        code: result.code,
        timedOut: result.timedOut,
        outputTruncated: result.outputTruncated
      })
    }
  }
  return observations
}
