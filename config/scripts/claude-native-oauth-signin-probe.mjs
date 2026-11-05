import { createServer } from 'node:https'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { nativeProbeCliInvocation, nativeProbeCliSha256 } from './claude-native-probe-cli.mjs'
if (process.platform !== 'linux' || process.env.OPKA_SYNTHETIC_LOOPBACK_SCOPE !== '1') {
  throw new Error('Qualified loopback-only Linux scope required')
}
const cli = process.argv[2]
const root = await mkdtemp(join(tmpdir(), 'opka-oob-'))
const home = join(root, 'home')
await mkdir(home)
const account = randomUUID()
const organization = randomUUID()
const key = join(root, 'tls.key')
const certificate = join(root, 'tls.crt')
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
let codeSent = false
let inference = 0
const server = createServer(
  { key: await readFile(key), cert: await readFile(certificate) },
  async (request, response) => {
    let body = ''
    for await (const chunk of request) {
      body += chunk
      if (body.length > 65536) {
        response.writeHead(413).end()
        return
      }
    }
    const path = new URL(request.url ?? '/', 'https://localhost').pathname
    if (path === '/v1/messages') {
      inference++
      response.writeHead(503).end()
      return
    }
    if (requests.length < 30) {
      requests.push({
        path,
        authorizationCode: body.includes('synthetic-oob-code'),
        grant: body.includes('authorization_code')
      })
    }
    const identity = {
      account: {
        uuid: account,
        email_address: 'synthetic@example.invalid',
        display_name: 'Synthetic'
      },
      organization: {
        uuid: organization,
        name: 'Synthetic',
        organization_type: 'claude_max',
        rate_limit_tier: 'default_claude_max_5x'
      }
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify(
        path.includes('token')
          ? {
              ...identity,
              access_token: 'sk-ant-oat01-synthetic-oob',
              refresh_token: 'synthetic-oob-refresh',
              expires_in: 86400,
              scope: 'user:inference user:profile',
              token_type: 'Bearer'
            }
          : identity
      )
    )
  }
)
await new Promise((done) => server.listen(443, '127.0.0.1', done))
const browser = join(root, 'browser')
await writeFile(browser, '#!/bin/sh\nprintf "%s" "$1" > "$0.link"\n', { mode: 0o700 })
const invocation = await nativeProbeCliInvocation(cli, ['auth', 'login', '--claudeai'])
const child = spawn(invocation.program, invocation.args, {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    HOME: root,
    CLAUDE_CONFIG_DIR: home,
    BROWSER: browser,
    NODE_EXTRA_CA_CERTS: certificate,
    ANTHROPIC_BASE_URL: 'https://claude.fedstart.com',
    CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://claude.fedstart.com',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1'
  },
  stdio: ['pipe', 'pipe', 'pipe']
})
let stdout = ''
let stderr = ''
let printed = null
child.stdout.on('data', (chunk) => {
  stdout = (stdout + chunk).slice(-65536)
  for (const match of stdout
    .replaceAll(String.fromCharCode(27), ' ')
    .matchAll(/https:\/\/claude\.fedstart\.com\/[^\s]+/g)) {
    try {
      const url = new URL(match[0])
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
      if (redirect.protocol === 'https:' && url.searchParams.get('state')) {
        printed = { url, redirect }
        if (!codeSent) {
          codeSent = true
          setTimeout(
            () => child.stdin.write(`synthetic-oob-code#${url.searchParams.get('state')}\n`),
            300
          )
        }
      }
    } catch {}
  }
})
child.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk).slice(-4096)
})
child.stdin.on('error', () => {})
const timer = setTimeout(() => child.kill('SIGTERM'), 6500)
const exit = await new Promise((done) => {
  child.once('exit', (code, signal) => done({ code, signal }))
  child.once('error', () => done({ code: null, signal: 'spawn' }))
})
clearTimeout(timer)
const browserUrl = await readFile(`${browser}.link`, 'utf8').then(
  (text) => new URL(text),
  () => null
)
let browserRedirect = null
try {
  browserRedirect = new URL(browserUrl?.searchParams.get('redirect_uri') ?? '')
} catch {}
const credentials =
  JSON.parse(await readFile(join(home, '.credentials.json'), 'utf8').catch(() => '{}'))
    .claudeAiOauth ?? {}
const state =
  JSON.parse(await readFile(join(home, '.claude-custom-oauth.json'), 'utf8').catch(() => '{}'))
    .oauthAccount ?? {}
const receipt = {
  sha256: await nativeProbeCliSha256(cli),
  exit,
  codeSent,
  printedOob: printed?.redirect.protocol === 'https:',
  browserLocalCallback:
    browserRedirect?.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(browserRedirect.hostname),
  requests,
  inference,
  accessWritten: credentials.accessToken === 'sk-ant-oat01-synthetic-oob',
  refreshWritten: credentials.refreshToken === 'synthetic-oob-refresh',
  identityMatched: state.accountUuid === account && state.organizationUuid === organization,
  stdoutBytes: Buffer.byteLength(stdout),
  stderrBytes: Buffer.byteLength(stderr)
}
console.log(JSON.stringify(receipt))
await new Promise((done) => server.close(done))
await rm(root, { recursive: true, force: true })
process.exitCode =
  receipt.inference || !receipt.accessWritten || !receipt.refreshWritten || !receipt.printedOob
    ? 1
    : 0
