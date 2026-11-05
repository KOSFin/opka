import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDarwinNativeProbeCi } from './claude-native-probe-cli.mjs'
import { prepareDarwinNativeEnvironment } from './claude-native-darwin-environment.mjs'
import { redactTranscript } from './pty-transcript-secret-scan.mjs'

if (!isDarwinNativeProbeCi()) {
  throw new Error('This qualification requires an isolated GitHub macOS runner')
}
const version = '2.1.318'
const root = await mkdtemp(join(tmpdir(), 'opka-native-darwin-'))
const output = resolve(process.argv[2] ?? 'native-darwin-receipts')
await mkdir(output, { recursive: true, mode: 0o700 })
let environment
let nativeCleanupVerified = true
async function checked(program, args, options = {}) {
  const result = await runProcess({ program, args, timeoutMs: 120000, ...options })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(
      `Isolated native qualification command failed (${result.code}): ${redactTranscript(result.stderr.slice(-4096)).text}`
    )
  }
  return result
}
async function metadata(name) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
    {
      signal: AbortSignal.timeout(15000),
      redirect: 'error'
    }
  )
  if (!response.ok) {
    throw new Error('Official native package metadata unavailable')
  }
  const text = await response.text()
  if (Buffer.byteLength(text) > 1024 * 1024) {
    throw new Error('Package metadata exceeds its bound')
  }
  return JSON.parse(text)
}
try {
  if (!['arm64', 'x64'].includes(process.arch)) {
    throw new Error('Unsupported runner architecture')
  }
  const base = await metadata('@anthropic-ai/claude-code')
  const native = await metadata(`@anthropic-ai/claude-code-darwin-${process.arch}`)
  const manifest = join(root, 'package.json')
  await writeFile(manifest, JSON.stringify({ base, native }), { mode: 0o600 })
  const cache = join(root, 'candidate')
  await checked(
    'python3',
    ['config/scripts/stage-claude-native-probe-package.py', manifest, cache],
    {
      env: { ...process.env, OPKA_ISOLATED_AUDIT_CACHE: '1' }
    }
  )
  const artifact = JSON.parse(await readFile(join(cache, 'receipt.json'), 'utf8'))
  await writeFile(join(output, 'artifact.json'), JSON.stringify(artifact, null, 2))
  const production = join(root, 'production-access.mjs')
  await build({
    stdin: {
      contents:
        "export {claudeKeychainService} from './src/main/claude-accounts/keychain.ts';" +
        "export {readClaudeNativeAccessSnapshot as readNativeAccessSnapshot} from './src/main/claude-accounts/claude-native-access.ts';",
      resolveDir: process.cwd()
    },
    outfile: production,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire as opkaFixtureCreateRequire } from 'node:module'; import {fileURLToPath as opkaFixtureFileURLToPath} from 'node:url'; import {dirname as opkaFixtureDirname} from 'node:path'; const __filename=opkaFixtureFileURLToPath(import.meta.url); const __dirname=opkaFixtureDirname(__filename); const require = opkaFixtureCreateRequire(import.meta.url);"
    },
    external: ['electron'],
    conditions: ['orca-source'],
    logLevel: 'silent'
  })
  const projection = await import(pathToFileURL(production).href)
  if (
    typeof projection.readNativeAccessSnapshot !== 'function' ||
    typeof projection.claudeKeychainService !== 'function'
  ) {
    throw new Error('Production access projection could not be loaded')
  }
  environment = await prepareDarwinNativeEnvironment(join(root, 'environment'))
  await checked(
    '/usr/bin/sandbox-exec',
    [
      '-f',
      environment.sandbox,
      process.execPath,
      '--input-type=module',
      '-e',
      `import net from 'node:net';
const server=net.createServer(socket=>socket.end());
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
await new Promise((resolve,reject)=>{const socket=net.connect(server.address().port,'127.0.0.1');socket.once('error',reject);socket.once('end',resolve)});
await new Promise((resolve,reject)=>{const socket=net.connect(443,'203.0.113.1');socket.setTimeout(1000,()=>{socket.destroy();reject(new Error('Egress denial not proven'))});socket.once('error',error=>{socket.destroy();['EPERM','EACCES'].includes(error.code)?resolve():reject(error)});socket.once('connect',()=>{socket.destroy();reject(new Error('Egress allowed'))})});
await new Promise(resolve=>server.close(resolve));
console.log('Loopback allowed; external connect denied by sandbox');`
    ],
    { timeoutMs: 5000 }
  )
  for (const mode of ['absent', 'present']) {
    const temporary = join(root, `temporary-${mode}`)
    await mkdir(temporary, { mode: 0o700 })
    const processReceipt = join(root, `${mode}-process.json`)
    nativeCleanupVerified = false
    const result = await runProcess({
      program: '/usr/bin/sandbox-exec',
      args: [
        '-f',
        environment.sandbox,
        process.execPath,
        resolve('config/scripts/claude-native-oauth-reload-probe.mjs'),
        artifact.executable,
        '--tui',
        join(output, `${mode}-transcript.txt`),
        '--access-token-only',
        '--no-model-change'
      ],
      timeoutMs: 45000,
      detached: true,
      terminationBarrier: true,
      maxOutputBytes: 1024 * 1024,
      env: {
        ...process.env,
        TMPDIR: temporary,
        ORCA_CAPTURE_PROCESS_RECEIPT: processReceipt,
        OPKA_DARWIN_PROBE_FENCE: '1',
        OPKA_DARWIN_KEYCHAIN_PATH: environment.keychain,
        OPKA_DARWIN_KEYCHAIN_MODE: mode,
        OPKA_DARWIN_PRODUCTION_MODULE: production,
        OPKA_DARWIN_KEYCHAIN_MODULE: resolve('config/scripts/claude-native-darwin-keychain.mjs')
      }
    })
    await writeFile(
      join(output, `${mode}-execution.json`),
      JSON.stringify(
        {
          code: result.code,
          signal: result.signal,
          timedOut: result.timedOut,
          outputTruncated: result.outputTruncated,
          stdout: redactTranscript(result.stdout.slice(-32768)).text,
          stderr: redactTranscript(result.stderr.slice(-32768)).text
        },
        null,
        2
      )
    )
    const nativeProcess = JSON.parse(await readFile(processReceipt, 'utf8'))
    if (
      !Number.isSafeInteger(nativeProcess.pid) ||
      nativeProcess.pid < 2 ||
      !nativeProcess.exited
    ) {
      throw new Error('Native PTY exit could not be verified; isolated keychain retained')
    }
    try {
      process.kill(-nativeProcess.pid, 0)
      throw new Error('Native PTY group remains live; isolated keychain retained')
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error
      }
    }
    nativeCleanupVerified = true
    const lines = result.stdout.trim().split('\n')
    const receipt = JSON.parse(lines.at(-1) ?? '{}')
    await writeFile(join(output, `${mode}.json`), JSON.stringify(receipt, null, 2))
    const observed = receipt.darwinKeychain
    if (
      result.timedOut ||
      result.outputTruncated ||
      receipt.error ||
      !observed?.sourceAccessReadable ||
      observed.refreshTokenExposed !== false ||
      observed.sourcePrefersKeychain !== (mode === 'present') ||
      receipt.finalHasRefreshToken !== false ||
      receipt.finalAccountMetadata !== 'B' ||
      receipt.finalOrganizationMetadata !== 'B' ||
      receipt.finalCredential !== 'B' ||
      (mode === 'absent' &&
        (result.code !== 0 ||
          !observed.sourceReadsFileB ||
          !receipt.oauthReloaded ||
          !receipt.requestIdentityCoherent)) ||
      (mode === 'present' &&
        !receipt.requests?.some((request) => request.secondPrompt && request.identity === 'A'))
    ) {
      throw new Error(`Native Darwin ${mode} qualification did not meet its contract`)
    }
    console.log(JSON.stringify({ case: mode, passed: true, sha256: receipt.sha256 }))
  }
} finally {
  if (nativeCleanupVerified) {
    await environment?.restore()
    await rm(root, { recursive: true, force: true })
  } else {
    console.error(
      'Native child cleanup unverifiable; fake-only CI keychain preserved until runner disposal'
    )
  }
}
