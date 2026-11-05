import process from 'node:process'
import console from 'node:console'
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'
import { createServer } from 'node:https'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import {
  prepareNativeUsageOpenInputFixture,
  buildNativeUsageProbeRuntime,
  readNativeUsageCredentialState,
  waitNativeUsageFreshSource
} from './claude-native-usage-open-input-fixture.mjs'
import { URL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeProbeCliInvocation, nativeProbeCliSha256 } from './claude-native-probe-cli.mjs'

if (process.platform !== 'linux' || process.env.OPKA_SYNTHETIC_LOOPBACK_SCOPE !== '1') {
  throw new Error('Requires the isolated Linux loopback-only qualification scope')
}
const executable = process.argv[2]
if (!executable || !isAbsolute(executable)) {
  throw new Error('An explicit qualified native executable is required')
}
const root = await mkdtemp(join(tmpdir(), 'opka-usage-open-input-'))
const config = join(root, 'config'),
  project = join(root, 'project')
await Promise.all([mkdir(config), mkdir(project)])
const api = await buildNativeUsageProbeRuntime(root)
const { tlsKey, certificate, credentialPath, oldRefresh, freshAccess, freshRefresh } =
  await prepareNativeUsageOpenInputFixture(root, config, project, api.runProcess)
const report = {
  schema: 1,
  hypothesis: 'usage-with-open-stream-json-input',
  nativeSha256: await nativeProbeCliSha256(executable),
  refreshRequests: 0,
  inferenceRequests: 0,
  otherRequests: 0,
  inlineResult: false,
  jsonMessageSent: false,
  resultWithOpenInput: false,
  localResultSuccess: false,
  aliveAfterResult: false,
  freshBeforeStop: false,
  rotatedBeforeStop: false,
  controlledStop: false,
  runnerResult: null,
  rootVerdict: null,
  groupAbsent: false,
  cleanupVerified: false,
  events: []
}
if (report.nativeSha256 !== '708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd') {
  throw new Error('Requires the previously registry-verified Linux2.1.318 executable')
}
const start = performance.now()
const event = (kind) => {
  if (report.events.length < 32) {
    report.events.push({ kind, elapsedMs: Math.round(performance.now() - start) })
  }
}
const cancel = new globalThis.AbortController()
const server = createServer(
  { key: await readFile(tlsKey), cert: await readFile(certificate) },
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
      report.inferenceRequests++
      event('inference-refused')
      response.writeHead(503).end()
      cancel.abort()
      return
    }
    if (path === '/v1/oauth/token') {
      if (!body.includes(oldRefresh) || !body.includes('refresh_token')) {
        response.writeHead(400).end()
        return
      }
      report.refreshRequests++
      event('fake-refresh-replied')
      response.writeHead(200, { 'content-type': 'application/json' }).end(
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
    report.otherRequests++
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  }
)
server.maxConnections = 8
server.requestTimeout = 8000
server.headersTimeout = 5000
server.keepAliveTimeout = 500
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(443, '127.0.0.1', resolve)
})
let group,
  writer,
  settled = false,
  buffer = '',
  outputBytes = 0,
  nativeSession
const invocation = await nativeProbeCliInvocation(executable, [
  '-p',
  '/usage',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--tools',
  '',
  '--strict-mcp-config',
  '--setting-sources',
  '',
  '--no-session-persistence'
])
const operation = api
  .runAgentModelCatalogListing(
    {
      command: invocation.program,
      args: invocation.args,
      cwd: project,
      keepStdinOpen: true,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        CLAUDE_CONFIG_DIR: config,
        NODE_EXTRA_CA_CERTS: certificate,
        ANTHROPIC_BASE_URL: 'https://claude.fedstart.com',
        CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://claude.fedstart.com',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1'
      }
    },
    {
      site: 'synthetic-usage-open-input',
      timeoutMs: 22000,
      maxOutputBytes: 262144,
      signal: cancel.signal,
      inheritedEnv: {},
      onGroupProven: (value) => {
        group = value
        event('native-group-proven')
      },
      onClosed: (closed) => {
        report.rootVerdict = closed.root
        event('production-close-settled')
      },
      onStdinReady: (write) => {
        writer = write
        event('stdin-ready')
      },
      onStdout: (chunk) => {
        outputBytes += Buffer.byteLength(chunk)
        buffer += chunk.toString()
        if (buffer.length > 262144) {
          cancel.abort()
          return
        }
        let end
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          try {
            const frame = JSON.parse(line)
            if (
              frame.type === 'system' &&
              frame.subtype === 'init' &&
              typeof frame.session_id === 'string'
            ) {
              nativeSession = frame.session_id
            }
            if (frame.type === 'result') {
              report.resultWithOpenInput = true
              report.localResultSuccess = frame.is_error === false || frame.subtype === 'success'
              report.inlineResult = !report.jsonMessageSent
              event(frame.is_error ? 'local-result-error' : 'local-result')
            }
          } catch {}
        }
      }
    }
  )
  .then(
    () => {
      report.runnerResult = 'natural-success'
    },
    (error) => {
      report.runnerResult = typeof error.reason === 'string' ? error.reason : 'failed'
    }
  )
  .finally(() => {
    settled = true
  })
try {
  for (let i = 0; i < 40 && !settled && !report.resultWithOpenInput; i++) {
    await delay(100)
  }
  if (!settled && !report.resultWithOpenInput && writer) {
    report.jsonMessageSent = true
    event('public-user-message-written')
    await writer(
      `${JSON.stringify({
        type: 'user',
        ...(nativeSession ? { session_id: nativeSession } : {}),
        message: { role: 'user', content: '/usage' },
        parent_tool_use_id: null
      })}\n`
    )
    for (let i = 0; i < 40 && !settled && !report.resultWithOpenInput; i++) {
      await delay(100)
    }
  }
  if (report.resultWithOpenInput && !settled) {
    await delay(1000)
    const row = group && (await api.readPosixProcessRow(group.pgid))
    report.aliveAfterResult =
      !settled &&
      !!row &&
      row !== 'unverifiable' &&
      row.startedAt === group.startedAt &&
      row.pgid === group.pgid
    event(report.aliveAfterResult ? 'native-still-live-after-result' : 'native-gone-after-result')
  }
  const source = await waitNativeUsageFreshSource(
    credentialPath,
    freshAccess,
    freshRefresh,
    () => settled
  )
  report.freshBeforeStop = source.fresh
  report.rotatedBeforeStop = source.rotated
  event('credential-source-read-before-stop')
  if (!settled) {
    report.controlledStop = true
    event('controlled-abort')
    cancel.abort()
  }
  await operation
  if (group) {
    try {
      process.kill(-group.pgid, 0)
    } catch (error) {
      report.groupAbsent = error.code === 'ESRCH'
    }
  }
  const final = await readNativeUsageCredentialState(credentialPath, freshAccess, freshRefresh)
  report.finalFresh = final.fresh
  report.finalRotated = final.rotated
  report.stdoutBytes = outputBytes
  report.cleanupVerified = report.rootVerdict === 'exited' && report.groupAbsent
  report.hypothesisSupported =
    report.localResultSuccess &&
    report.aliveAfterResult &&
    report.freshBeforeStop &&
    report.rotatedBeforeStop &&
    report.inferenceRequests === 0 &&
    report.cleanupVerified
} finally {
  cancel.abort()
  await operation
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  if (report.cleanupVerified) {
    await rm(root, { recursive: true, force: true })
  }
  console.log(JSON.stringify(report))
}
process.exitCode = report.inferenceRequests > 0 || !report.cleanupVerified ? 1 : 0
