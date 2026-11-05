import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rename, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { redactTranscript } from './pty-transcript-secret-scan.mjs'
import { writeSyntheticClaudeResponse } from './claude-native-probe-response.mjs'
import { NativeClaudeProbeStopFence } from './claude-native-probe-stop-fence.mjs'
import {
  nativeProbeCliInvocation,
  nativeProbeCliSha256,
  isDarwinNativeProbeCi
} from './claude-native-probe-cli.mjs'
import { NativeClaudeProbeLimitFailover } from './claude-native-probe-limit-failover.mjs'

// Runs only inside the caller's loopback-only systemd scope with a fresh synthetic home.
const darwinScope = isDarwinNativeProbeCi() && process.env.OPKA_DARWIN_PROBE_FENCE === '1'
if (
  !darwinScope &&
  (process.platform !== 'linux' || process.env.OPKA_SYNTHETIC_LOOPBACK_SCOPE !== '1')
) {
  throw new Error('Run in the qualified Linux loopback-only scope')
}
const cli = process.argv[2]
const tui = process.argv[3] === '--tui'
const accessTokenOnly = process.argv.includes('--access-token-only')
const confirmModelChange = process.argv.includes('--confirm-model-change')
const noModelChange = process.argv.includes('--no-model-change')
const limitMode = process.argv.includes('--main-429-retry-swap')
  ? 'retry-swap'
  : process.argv.includes('--stop-failure-signed-two-phase')
    ? 'signed-two-phase'
    : process.argv.includes('--stop-failure-two-phase-rewake')
      ? 'two-phase-rewake'
      : process.argv.includes('--stop-failure-gated-rewake')
        ? 'gated-rewake'
        : process.argv.includes('--stop-failure-rewake')
          ? 'stop-failure-rewake'
          : null
if (limitMode && (!tui || !accessTokenOnly)) {
  throw new Error('Limit probe requires native TUI AT-only facade')
}
if (process.argv.includes('--stop-fence') && (!tui || !accessTokenOnly)) {
  throw new Error('Stop fence requires TUI and an AT-only synthetic facade')
}
const transcriptOutput = process.argv[4]
if (tui && (!transcriptOutput || !isAbsolute(transcriptOutput))) {
  throw new Error('TUI capture requires an absolute private output file')
}
let swapped = false
if (!cli || !isAbsolute(cli)) {
  throw new Error('An explicit pinned native Claude CLI file is required')
}
const root = await mkdtemp(join(tmpdir(), 'opka-claude-oauth-'))
const config = join(root, 'config')
const cwd = join(root, 'project')
await Promise.all([mkdir(config), mkdir(cwd)])
const tokenA = 'sk-ant-oat01-synthetic-probe-a'
const tokenB = 'sk-ant-oat01-synthetic-probe-b'
const accountA = {
  accountUuid: randomUUID(),
  organizationUuid: randomUUID(),
  emailAddress: 'a@example.invalid'
}
const accountB = {
  accountUuid: randomUUID(),
  organizationUuid: randomUUID(),
  emailAddress: 'b@example.invalid'
}
let darwinKeychain
if (darwinScope) {
  const module = process.env.OPKA_DARWIN_KEYCHAIN_MODULE
  if (!module || !isAbsolute(module)) {
    throw new Error('Missing isolated Darwin keychain probe')
  }
  const { prepareDarwinProbeKeychain } = await import(pathToFileURL(module).href)
  darwinKeychain = await prepareDarwinProbeKeychain({ config, tokenA, accountA })
}
const mapped = (value, field) => {
  const text = JSON.stringify(value ?? '')
  return text.includes(accountA[field]) ? 'A' : text.includes(accountB[field]) ? 'B' : 'none'
}
const metadata = async (account) => {
  const path = join(config, '.claude.json')
  const state = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(`${path}.new`, JSON.stringify({ ...state, oauthAccount: account }), {
    mode: 0o600
  })
  await rename(`${path}.new`, path)
}
const switchToB = async () => {
  await credentials(tokenB)
  await metadata(accountB)
}

const credentials = async (token) => {
  const path = join(config, '.credentials.json')
  await writeFile(
    `${path}.new`,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        ...(accessTokenOnly ? {} : { refreshToken: 'synthetic-unused-refresh' }),
        expiresAt: Date.now() + 86400000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x'
      }
    }),
    { mode: 0o600 }
  )
  await rename(`${path}.new`, path)
}
await credentials(tokenA)
await writeFile(
  join(config, '.claude.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    theme: 'dark',
    oauthAccount: accountA,
    projects: { [cwd]: { hasTrustDialogAccepted: true } }
  }),
  { mode: 0o600 }
)
await writeFile(join(config, 'settings.json'), '{}', { mode: 0o600 })
const stopFence = process.argv.includes('--stop-fence')
  ? new NativeClaudeProbeStopFence(switchToB)
  : null
const limitFailover = limitMode ? new NativeClaudeProbeLimitFailover(limitMode, switchToB) : null
const requests = []
const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 2 * 1024 * 1024) {
      res.writeHead(413).end()
      return
    }
  }
  let parsed = {}
  try {
    parsed = JSON.parse(body || '{}')
  } catch {}
  const authorization = req.headers.authorization
  const identity =
    authorization === `Bearer ${tokenA}` ? 'A' : authorization === `Bearer ${tokenB}` ? 'B' : 'none'
  if (requests.length < 100) {
    requests.push({
      path: req.url?.split('?')[0],
      identity,
      model: parsed.model ?? null,
      firstPrompt: body.includes('synthetic-first-turn'),
      secondPrompt: body.includes('synthetic-second-turn'),
      metadataUserIdPresent: parsed.metadata?.user_id !== undefined,
      metadataUserAccount: mapped(parsed.metadata?.user_id, 'accountUuid'),
      metadataUserOrganization: mapped(parsed.metadata?.user_id, 'organizationUuid'),
      headersAccount: mapped(req.headers, 'accountUuid'),
      headersOrganization: mapped(req.headers, 'organizationUuid'),
      bodyAccount: mapped(parsed, 'accountUuid'),
      bodyOrganization: mapped(parsed, 'organizationUuid')
    })
  }
  if (stopFence && req.url === '/probe-stop') {
    await stopFence.handleStop(res)
    return
  }
  if (await limitFailover?.handleHook(req.url, res, parsed)) {
    return
  }
  if (req.url?.includes('/count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}')
    return
  }
  if (req.url?.split('?')[0] !== '/v1/messages') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    return
  }
  stopFence?.observeInference(res)
  if (await limitFailover?.handleMessage(res, identity, body)) {
    return
  }
  if (
    stopFence?.holdTitle(parsed, body, (failure) =>
      writeSyntheticClaudeResponse(res, parsed, failure)
    )
  ) {
    return
  }
  writeSyntheticClaudeResponse(res, parsed)
  if (
    !stopFence &&
    !limitFailover &&
    tui &&
    parsed.model === 'claude-sonnet-4-5' &&
    !swapped &&
    body.includes('synthetic-first-turn') &&
    !body.includes('synthetic-second-turn')
  ) {
    swapped = true
    await switchToB()
  }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const address = server.address()
if (typeof address !== 'object' || !address) {
  throw new Error('Missing loopback address')
}
await stopFence?.install(config, root, address.port)
await limitFailover?.install(config, root, address.port)
const transcript = join(root, 'native-tui.txt')
const tuiInvocation = await nativeProbeCliInvocation(cli, ['--model', 'claude-sonnet-4-5'])
const nativeArgs = tui
  ? [
      fileURLToPath(new URL('./capture-agent-pty-transcript.mjs', import.meta.url)),
      '--out',
      transcript,
      '--duration',
      stopFence ? (confirmModelChange ? '18' : '16') : confirmModelChange ? '15' : '12',
      '--cols',
      '120',
      '--rows',
      '40',
      '--send',
      String.raw`2000:synthetic-first-turn\r`,
      ...(limitFailover
        ? []
        : [
            ...(noModelChange
              ? []
              : [
                  '--send',
                  stopFence
                    ? String.raw`9500:/model claude-haiku-4-5\r`
                    : String.raw`4500:/model claude-haiku-4-5\r`
                ]),
            ...(confirmModelChange
              ? ['--send', stopFence ? String.raw`11500:\r` : String.raw`7000:\r`]
              : []),
            '--send',
            stopFence
              ? confirmModelChange
                ? String.raw`14000:synthetic-second-turn\r`
                : String.raw`12000:synthetic-second-turn\r`
              : confirmModelChange
                ? String.raw`10000:synthetic-second-turn\r`
                : String.raw`7500:synthetic-second-turn\r`
          ]),
      '--',
      tuiInvocation.program,
      ...tuiInvocation.args
    ]
  : [
      cli,
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'claude-sonnet-4-5'
    ]
const invocation = tui
  ? { program: process.execPath, args: nativeArgs }
  : await nativeProbeCliInvocation(cli, nativeArgs.slice(1))
const child = spawn(invocation.program, invocation.args, {
  cwd,
  env: {
    PATH: process.env.PATH,
    ORCA_CAPTURE_NODE_PTY_MODULE: process.env.ORCA_CAPTURE_NODE_PTY_MODULE,
    ORCA_CAPTURE_PROCESS_RECEIPT: process.env.ORCA_CAPTURE_PROCESS_RECEIPT,
    HOME: root,
    CLAUDE_CONFIG_DIR: config,
    TERM: 'xterm-256color',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    NO_COLOR: '1'
  },
  stdio: ['pipe', 'pipe', 'pipe']
})
let results = 0
let successfulResults = 0
let buffer = ''
let stderrBytes = 0
let stderrTail = ''
let error = null
let pending = Promise.resolve()
let session = ''
const send = (text) =>
  child.stdin.write(
    `${JSON.stringify({ type: 'user', session_id: session, message: { role: 'user', content: text }, parent_tool_use_id: null })}\n`
  )
child.stderr.on('data', (chunk) => {
  stderrBytes += chunk.length
  stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000)
})
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  if (tui) {
    return
  }
  buffer += chunk
  if (buffer.length > 1024 * 1024) {
    error = 'stdout-limit'
    child.kill()
    return
  }
  let newline
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof frame.session_id === 'string') {
      session = frame.session_id
    }
    if (frame.type === 'result') {
      results++
      if (frame.is_error === false && frame.subtype === 'success') {
        successfulResults++
      }
      if (results === 1) {
        pending = pending.then(async () => {
          await switchToB()
          send('synthetic-second-turn')
        })
      } else {
        child.stdin.end()
      }
    }
  }
})
const timer = setTimeout(() => {
  error = 'timeout'
  child.kill('SIGTERM')
}, 30000)
if (!tui) {
  send('synthetic-first-turn')
}
const exit = await new Promise((done) => {
  child.once('exit', (code, signal) => done({ code, signal }))
  child.once('error', () => {
    error = 'spawn'
    done({ code: null, signal: null })
  })
})
clearTimeout(timer)
await pending
stopFence?.dispose()
await new Promise((done) => server.close(done))
const messages = requests.filter(
  (request) => request.path === '/v1/messages' && (request.firstPrompt || request.secondPrompt)
)
const finalCredentials =
  JSON.parse(await readFile(join(config, '.credentials.json'), 'utf8').catch(() => '{}'))
    .claudeAiOauth ?? {}
const finalGlobal =
  JSON.parse(await readFile(join(config, '.claude.json'), 'utf8').catch(() => '{}')).oauthAccount ??
  {}
const receipt = {
  darwinKeychain: await darwinKeychain?.observe(accountB),
  mode: tui ? 'native-tui' : 'native-stream-json',
  cli: resolve(cli),
  sha256: await nativeProbeCliSha256(cli),
  results,
  successfulResults,
  exit,
  error,
  stderrBytes,
  accessTokenOnly,
  noModelChange,
  finalHasRefreshToken: Boolean(finalCredentials.refreshToken),
  stopFenceEvents: stopFence?.events ?? [],
  limitFailoverEvents: limitFailover?.events ?? [],
  probeSha256: createHash('sha256')
    .update(await readFile(import.meta.filename))
    .digest('hex'),
  finalAccountMetadata: mapped(finalGlobal, 'accountUuid'),
  finalOrganizationMetadata: mapped(finalGlobal, 'organizationUuid'),
  finalCredential:
    finalCredentials.accessToken === tokenB
      ? 'B'
      : finalCredentials.accessToken === tokenA
        ? 'A'
        : 'none',
  requestIdentityCoherent: messages.every(
    (request) => request.identity === request.metadataUserAccount
  ),
  requests,
  oauthReloaded:
    messages.some((request) => request.identity === 'A') &&
    messages.some(
      (request) =>
        (limitFailover ? request.firstPrompt : request.secondPrompt) && request.identity === 'B'
    )
}
if (tui) {
  const captured = await readFile(transcript, 'utf8').catch(() => null)
  if (captured === null) {
    receipt.error = 'capture-unavailable'
    receipt.captureError = redactTranscript(stderrTail).text
  } else {
    const scrubbed = redactTranscript(captured).text
    await writeFile(transcriptOutput, scrubbed, { mode: 0o600, flag: 'wx' })
    receipt.transcriptSha256 = createHash('sha256').update(scrubbed).digest('hex')
    receipt.transcriptBytes = Buffer.byteLength(scrubbed)
  }
}
console.log(JSON.stringify(receipt))
await darwinKeychain?.dispose()
await rm(root, { recursive: true, force: true })
process.exitCode =
  receipt.error ||
  !receipt.requestIdentityCoherent ||
  receipt.finalAccountMetadata !== 'B' ||
  receipt.finalOrganizationMetadata !== 'B' ||
  (accessTokenOnly && receipt.finalHasRefreshToken) ||
  (tui ? !receipt.oauthReloaded : results !== 2 || successfulResults !== 2)
    ? 1
    : 0
