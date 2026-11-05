import { createServer, get } from 'node:https'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { nativeProbeCliInvocation, nativeProbeCliSha256 } from './claude-native-probe-cli.mjs'

if (process.platform !== 'linux' || process.env.OPKA_SYNTHETIC_LOOPBACK_SCOPE !== '1') {
  throw new Error('Run inside the qualified Linux loopback-only scope')
}
const cli = process.argv[2]
if (!cli || !isAbsolute(cli)) {
  throw new Error('An explicit pinned native CLI is required')
}
const root = await mkdtemp(join(tmpdir(), 'opka-native-refresh-'))
const config = join(root, 'config')
const cwd = join(root, 'project')
await Promise.all([mkdir(config), mkdir(cwd)])
const oldAccess = 'sk-ant-oat01-synthetic-old-a'
const freshAccess = 'sk-ant-oat01-synthetic-fresh-a'
const oldRefresh = 'synthetic-refresh-old-a'
const freshRefresh = 'synthetic-refresh-fresh-a'
const accountUuid = randomUUID()
const organizationUuid = randomUUID()
const key = join(root, 'mock-tls.key')
const certificate = join(root, 'mock-tls.crt')
execFileSync(
  '/usr/bin/openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    certificate,
    '-days',
    '1',
    '-subj',
    '/CN=claude.fedstart.com',
    '-addext',
    'subjectAltName=DNS:claude.fedstart.com'
  ],
  { stdio: 'ignore' }
)
const requests = []
let activeMode = ''
const tlsCertificate = await readFile(certificate)
const server = createServer(
  { key: await readFile(key), cert: tlsCertificate },
  async (req, res) => {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 65536) {
        res.writeHead(413).end()
        return
      }
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (requests.length < 100) {
      requests.push({
        mode: activeMode,
        path: path.replaceAll(accountUuid, 'ACCOUNT_A').replaceAll(organizationUuid, 'ORG_A'),
        refreshGrant: body.includes('refresh_token'),
        expectedRefreshToken: body.includes(oldRefresh),
        inference: path === '/v1/messages'
      })
    }
    if (path === '/v1/messages') {
      res.writeHead(503).end()
      return
    }
    if (path.includes('token')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          access_token: freshAccess,
          refresh_token: freshRefresh,
          expires_in: 86400,
          token_type: 'Bearer',
          scope: 'user:inference user:profile'
        })
      )
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  }
)
await new Promise((done) => server.listen(443, '127.0.0.1', done))
const address = server.address()
if (!address || typeof address !== 'object') {
  throw new Error('Missing loopback address')
}
const base = 'https://claude.fedstart.com'
await new Promise((done, fail) => {
  get(`${base}/probe-tls-health`, { ca: tlsCertificate }, (res) => {
    res.resume()
    res.once('end', done)
  }).once('error', fail)
})

const growth = [],
  homeGrowth = []
async function measure(directory) {
  let files = 0,
    bytes = 0
  const pending = [directory]
  while (pending.length) {
    for (const entry of await readdir(pending.pop(), { withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name),
        info = await lstat(path)
      if (info.isSymbolicLink()) {
        continue
      }
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.isFile()) {
        files++
        bytes += info.size
      }
      if (files > 2048 || pending.length > 2048) {
        throw new Error('Synthetic native source growth exceeded bounded walk')
      }
    }
  }
  return { files, bytes }
}
const modes = []
for (const mode of process.argv.includes('--repeat-usage')
  ? Array(5).fill('usage')
  : process.argv.includes('--usage-only')
    ? ['version', 'usage']
    : ['auth-status', 'initialize', 'list_models']) {
  activeMode = mode
  const credentialPath = join(config, '.credentials.json')
  await writeFile(
    credentialPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: oldAccess,
        refreshToken: oldRefresh,
        expiresAt: Date.now() - 60000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max'
      }
    }),
    { mode: 0o600 }
  )
  const before = await readFile(credentialPath, 'utf8')
  const global = {
    hasCompletedOnboarding: true,
    theme: 'dark',
    oauthAccount: { accountUuid, organizationUuid, emailAddress: 'a@example.invalid' },
    projects: { [cwd]: { hasTrustDialogAccepted: true } }
  }
  for (const name of ['.claude.json', '.claude-custom-oauth.json']) {
    await writeFile(join(config, name), JSON.stringify(global), { mode: 0o600 })
  }
  await writeFile(join(config, 'settings.json'), '{"disableAllHooks":true}', { mode: 0o600 })
  // Same no-turn flags and initialize request as the existing native command catalog probe.
  const args =
    mode === 'version'
      ? ['--version']
      : mode === 'usage'
        ? [
            '-p',
            '/usage',
            '--output-format',
            'json',
            '--tools',
            '',
            '--strict-mcp-config',
            '--setting-sources',
            '',
            '--no-session-persistence'
          ]
        : mode === 'auth-status'
          ? ['auth', 'status']
          : [
              '-p',
              '--input-format',
              'stream-json',
              '--output-format',
              'stream-json',
              '--verbose',
              '--strict-mcp-config',
              '--settings',
              '{"disableAllHooks":true}'
            ]
  const invocation = await nativeProbeCliInvocation(cli, args)
  const child = spawn(invocation.program, invocation.args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_BASE_URL: base,
      CLAUDE_CODE_CUSTOM_OAUTH_URL: base,
      ...(mode === 'usage' ? {} : { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }),
      NODE_EXTRA_CA_CERTS: certificate,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  child.stdout.on('data', (chunk) => {
    stdout = (stdout + chunk).slice(-262144)
  })
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4096)
  })
  child.stdin.on('error', () => {})
  let killTimer
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
  }, 6000)
  if (mode === 'auth-status' || mode === 'usage' || mode === 'version') {
    child.stdin.end()
  } else {
    child.stdin.end(
      `${JSON.stringify({ type: 'control_request', request_id: 'synthetic-metadata-only', request: { subtype: mode } })}\n`
    )
  }
  const exit = await new Promise((done) => {
    child.once('exit', (code, signal) => done({ code, signal }))
    child.once('error', () => done({ code: null, signal: 'spawn-error' }))
  })
  clearTimeout(timer)
  clearTimeout(killTimer)
  const after = await readFile(credentialPath, 'utf8').catch(() => '{}')
  const stored = JSON.parse(after).claudeAiOauth ?? {}
  const frames = []
  try {
    frames.push(JSON.parse(stdout))
  } catch {
    for (const line of stdout.split('\n')) {
      try {
        frames.push(JSON.parse(line))
      } catch {}
    }
  }
  growth.push(await measure(config))
  homeGrowth.push(await measure(root))
  modes.push({
    mode,
    nativeVersion: mode === 'version' ? (stdout.trim().match(/^\d+\.\d+\.\d+/)?.[0] ?? null) : null,
    exit,
    timedOut,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    usageCommandUnsupported:
      /unknown (?:skill|slash command).*usage|usage.*only.*interactive/i.test(stdout + stderr),
    customOAuthEndpointRefused: /not an approved endpoint/i.test(stdout + stderr),
    unknownOption: /unknown option|unknown command/i.test(stderr),
    networkError: /ENETUNREACH|ECONNREFUSED|fetch failed/i.test(stderr),
    loggedIn: frames.find((frame) => typeof frame.loggedIn === 'boolean')?.loggedIn ?? null,
    controlSuccess: frames.some(
      (frame) => frame.type === 'control_response' && frame.response?.subtype === 'success'
    ),
    credentialChanged: before !== after,
    accessToken:
      stored.accessToken === freshAccess
        ? 'A-fresh'
        : stored.accessToken === oldAccess
          ? 'A-old'
          : 'none',
    refreshTokenRotated: stored.refreshToken === freshRefresh
  })
}
await new Promise((done) => server.close(done))
console.log(
  JSON.stringify({
    cliSha256: await nativeProbeCliSha256(cli),
    probeSha256: createHash('sha256')
      .update(await readFile(import.meta.filename))
      .digest('hex'),
    modes,
    growth,
    homeGrowth,
    requests,
    noInference: requests.every((request) => !request.inference)
  })
)
await rm(root, { recursive: true, force: true })
process.exitCode = requests.some((request) => request.inference) ? 1 : 0
