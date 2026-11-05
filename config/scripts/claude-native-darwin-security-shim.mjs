import { build } from 'esbuild'
import { mkdir, chmod, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { isDarwinNativeProbeCi } from './claude-native-probe-cli.mjs'
import { readSecurityDiagnosticTrace } from './claude-native-darwin-security-shim-runner.mjs'

export async function prepareDarwinSecurityDiagnostic(root) {
  if (!isDarwinNativeProbeCi()) {
    throw new Error('Security diagnostic shim requires isolated Darwin CI')
  }
  const canonical = await realpath(root)
  const directory = join(canonical, 'security-diagnostic-shim')
  const traceDirectory = join(directory, 'trace')
  await mkdir(directory, { mode: 0o700 })
  await mkdir(traceDirectory, { mode: 0o700 })
  const executable = join(directory, 'security')
  await build({
    stdin: {
      contents: `import process from 'node:process';
import {forwardSecurityDiagnostic} from './claude-native-darwin-security-shim-runner.mjs';
const result=await forwardSecurityDiagnostic({program:'/usr/bin/security',args:process.argv.slice(2),traceDirectory:${JSON.stringify(traceDirectory)}});
if(result.signal)process.kill(process.pid,result.signal);else process.exitCode=result.code??127;`,
      resolveDir: import.meta.dirname
    },
    outfile: executable,
    bundle: true,
    platform: 'node',
    format: 'esm',
    conditions: ['orca-source'],
    banner: {
      js: `#!${process.execPath}\nimport {createRequire as opkaSecurityCreateRequire} from 'node:module'; const require=opkaSecurityCreateRequire(import.meta.url);`
    },
    logLevel: 'silent'
  })
  await chmod(executable, 0o700)
  return { directory, read: () => readSecurityDiagnosticTrace(traceDirectory) }
}
