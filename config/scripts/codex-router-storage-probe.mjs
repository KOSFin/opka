import { createServer, request as httpRequest } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnProcess } from '@orca/process-host'

const option = (name) => process.argv[process.argv.indexOf(name) + 1]
const program = option('--engine')
const output = option('--output')
if (
  !process.argv.includes('--engine') ||
  !process.argv.includes('--output') ||
  !program ||
  !output ||
  resolve(program) !== program ||
  resolve(output) !== output
) {
  throw new Error('Pass --engine <absolute pinned binary> --output <absolute receipt.json>')
}
const productionLaunch = process.argv.includes('--production-launch')
const root = await mkdtemp(join(tmpdir(), 'opka-router-storage-'))
const canary = `synthetic-content-${randomUUID()}`
let clientKey = `synthetic-client-${randomUUID()}`
const requestLimit = 32 * 1024
const responseLimit = 256 * 1024
let mode = 'success'
let engine, upstream, front, receipt, productionEngine
const stdoutCanaryLines = new Set()
let stdoutBytes = 0,
  stdoutCanary = false,
  stdoutTail = '',
  active = 0,
  peakActive = 0,
  beforeBodyErrors = 0
const openRequests = new Set()
const timers = new Set()
const listen = async (server) => {
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  return `http://127.0.0.1:${server.address().port}`
}
const close = async (server) => {
  if (!server) {
    return
  }
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
}
const check = (condition, message) => {
  if (!condition) {
    throw new Error(message)
  }
}
const snapshot = async () => {
  const files = []
  let contentFound = false
  const walk = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      check(files.length < 256, 'Scratch file count exceeded scan budget')
      const path = join(directory, entry.name),
        relative = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        await walk(path, `${relative}/`)
        continue
      }
      check(entry.isFile(), 'Unexpected scratch file type')
      const metadata = await stat(path)
      check(metadata.size <= 8 * 1024 * 1024, 'Scratch file exceeded scan budget')
      const data = await readFile(path)
      contentFound ||= data.includes(Buffer.from(canary))
      files.push({ path: relative, bytes: metadata.size, blocks: metadata.blocks })
    }
  }
  await walk(root)
  check(!contentFound, 'Synthetic request content persisted to disk')
  check(
    !files.some((file) => /(?:request|response|error)-.*\.(?:log|tmp)$|kv\.db/.test(file.path)),
    'Request log, spool or KV file created'
  )
  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    canaryFound: contentFound
  }
}
const stopEngine = async (signal = 'SIGTERM') => {
  if (productionEngine) {
    if (signal === 'SIGKILL') {
      await productionEngine.forceStop()
    }
    const proof = await productionEngine.stop()
    check(proof.root === 'exited', 'Engine shutdown remains unverifiable')
    return
  }
  if (!engine || engine.exitCode !== null || engine.signalCode !== null) {
    return
  }
  const exited = once(engine, 'close')
  engine.kill(signal)
  const force = setTimeout(() => engine.kill('SIGKILL'), 1000)
  await exited
  clearTimeout(force)
}
try {
  const binaryHash = createHash('sha256')
  for await (const chunk of createReadStream(program)) {
    binaryHash.update(chunk)
  }
  const binarySha256 = binaryHash.digest('hex')
  await mkdir(join(root, 'empty-auth'), { mode: 0o700 })
  upstream = createServer(async (incoming, outgoing) => {
    incoming.resume()
    if (mode === '403' || mode === '429') {
      beforeBodyErrors += 1
      outgoing
        .writeHead(Number(mode), { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: canary, type: 'synthetic' } }))
      return
    }
    const completed = {
      id: `resp_${randomUUID()}`,
      object: 'response',
      status: 'completed',
      model: 'probe',
      output: [
        {
          type: 'message',
          id: 'msg_probe',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: canary, annotations: [] }]
        }
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    }
    outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    outgoing.write(
      `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } })}\n\n`
    )
    outgoing.write(
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: canary, output_index: 0, content_index: 0 })}\n\n`
    )
    if (mode === 'partial' || mode === 'cancel' || mode === 'crash') {
      if (mode === 'partial') {
        const timer = setTimeout(() => {
          timers.delete(timer)
          outgoing.destroy()
        }, 30)
        timers.add(timer)
      }
      return
    }
    outgoing.end(
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`
    )
  })
  const upstreamBase = await listen(upstream)
  const reservation = createServer()
  const engineBase = await listen(reservation)
  const port = reservation.address().port
  await close(reservation)
  const configPath = join(root, 'config.json')
  await writeFile(
    configPath,
    JSON.stringify({
      'config-version': 8,
      server: {
        host: '127.0.0.1',
        port,
        'commercial-mode': true,
        'max-request-body-bytes': 16 * 1024,
        'kv-store': { disabled: true },
        discovery: { enabled: false }
      },
      management: {
        'secret-key': '',
        'allow-remote': false,
        'disable-control-panel': true,
        'disable-auto-update-panel': true
      },
      access: { 'api-keys': [clientKey] },
      oauth: { 'auth-dir': join(root, 'empty-auth'), 'auth-auto-refresh-workers': 1 },
      routing: {
        strategy: 'fill-first',
        'session-affinity': false,
        retry: { 'request-retry': 0, 'max-retry-interval': 0 },
        cooldown: { 'disable-cooling': true, 'save-cooldown-status': false }
      },
      'api-keys': {
        codex: [
          {
            name: 'synthetic',
            'base-url': `${upstreamBase}/v1`,
            'request-retry': 0,
            models: [{ name: 'probe' }],
            keys: [
              { 'api-key': 'synthetic-no-provider-credential', 'disable-codex-cloaking': true }
            ]
          }
        ]
      },
      observability: {
        logs: { debug: false, 'logging-to-file': false, 'request-log': false },
        usage: { 'usage-statistics-enabled': false },
        pprof: { enable: false }
      },
      plugins: { enabled: false }
    }),
    { mode: 0o600 }
  )
  const startEngine = async () => {
    if (productionLaunch) {
      process.env.ORCA_USER_DATA_PATH = join(root, 'host-data')
      const { startEngineRuntime } = await import('../../src/main/codex-routing/engine-runtime.ts')
      productionEngine = await startEngineRuntime({
        binaryPath: program,
        expectedSha256: binarySha256,
        directory: root,
        port,
        auth: { kind: 'synthetic-test', upstream: `${upstreamBase}/v1` },
        maxRequestBytes: 16 * 1024,
        memoryMiB: 128,
        assertExclusiveRuntimeDirectory() {
          check(
            !productionEngine || productionEngine.verdict === 'exited',
            'Previous engine still owns runtime directory'
          )
        }
      })
      clientKey = productionEngine.clientKey
      return
    }
    const env = Object.fromEntries(
      ['PATH', 'SystemRoot', 'WINDIR', 'LANG']
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]])
    )
    engine = spawnProcess({
      program,
      args: ['-config', configPath, '-local-model'],
      cwd: root,
      env: {
        ...env,
        HOME: root,
        USERPROFILE: root,
        TMPDIR: root,
        TMP: root,
        TEMP: root,
        ORCA_BACKGROUND_LAUNCH: '1',
        GOMAXPROCS: '1',
        GOMEMLIMIT: '128MiB'
      },
      stdio: 'pipe'
    })
    engine.on('error', () => {})
    engine.stdin.on('error', () => {})
    for (const stream of [engine.stdout, engine.stderr]) {
      stream.on('data', (chunk) => {
        stdoutBytes += chunk.length
        const text = stdoutTail + chunk.toString()
        stdoutCanary ||= text.includes(canary)
        for (const line of text.split('\n')) {
          if (line.includes(canary) && stdoutCanaryLines.size < 3) {
            stdoutCanaryLines.add(line.replaceAll(canary, '[CANARY]').slice(0, 240))
          }
        }
        stdoutTail = text.slice(-canary.length)
      })
    }
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      check(
        engine.exitCode === null && engine.signalCode === null,
        'Engine exited before readiness'
      )
      try {
        const result = await fetch(`${engineBase}/v1/models`, {
          headers: { authorization: `Bearer ${clientKey}` },
          signal: AbortSignal.timeout(300)
        })
        if (result.ok) {
          await result.arrayBuffer()
          return
        }
      } catch {
        /* Isolated listener may still be starting. */
      }
      await new Promise((done) => setTimeout(done, 40))
    }
    throw new Error('Engine readiness deadline exceeded')
  }
  await startEngine()
  front = createServer(async (incoming, outgoing) => {
    if (incoming.url !== '/v1/responses' || incoming.method !== 'POST') {
      outgoing.writeHead(404).end()
      return
    }
    if (active >= 1) {
      incoming.resume()
      outgoing.writeHead(429).end()
      return
    }
    active += 1
    peakActive = Math.max(peakActive, active)
    let pending
    const cancel = () => pending?.destroy()
    outgoing.once('close', cancel)
    try {
      const chunks = []
      let bytes = 0
      for await (const chunk of incoming) {
        bytes += chunk.length
        if (bytes > requestLimit) {
          outgoing.writeHead(413).end()
          return
        }
        chunks.push(chunk)
      }
      pending = httpRequest(`${engineBase}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' }
      })
      openRequests.add(pending)
      const response = await new Promise((done, reject) => {
        pending.once('response', done)
        pending.once('error', reject)
        pending.end(Buffer.concat(chunks))
      })
      outgoing.writeHead(response.statusCode, {
        'content-type': response.headers['content-type'] ?? 'application/json'
      })
      let count = 0
      for await (const chunk of response) {
        count += chunk.length
        check(count <= responseLimit, 'Response exceeded probe byte limit')
        if (!outgoing.write(chunk)) {
          await once(outgoing, 'drain')
        }
      }
      outgoing.end()
    } catch {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502).end()
      } else {
        outgoing.destroy()
      }
    } finally {
      outgoing.off('close', cancel)
      pending?.destroy()
      openRequests.delete(pending)
      active -= 1
    }
  })
  front.on('upgrade', (_incoming, socket) =>
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  )
  const frontBase = await listen(front)
  const send = async (
    kind,
    body = JSON.stringify({ model: 'probe', stream: true, input: canary })
  ) => {
    mode = kind
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2500)
    try {
      const response = await fetch(`${frontBase}/v1/responses`, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json' },
        signal: controller.signal
      })
      if (kind === 'cancel' || kind === 'crash') {
        await response.body.getReader().read()
        await snapshot()
        if (kind === 'crash') {
          await stopEngine('SIGKILL')
        } else {
          const rejected = await fetch(`${frontBase}/v1/responses`, {
            method: 'POST',
            body,
            signal: AbortSignal.timeout(500)
          })
          await rejected.arrayBuffer()
          check(rejected.status === 429, 'Concurrent request was not rejected before admission')
        }
        controller.abort()
        return { kind, status: response.status, cancelled: true }
      }
      try {
        const text = await response.text()
        return {
          kind,
          status: response.status,
          bodySeen: text.includes(canary),
          contentType: response.headers.get('content-type'),
          completed: /event:\s*response\.completed\s*\r?\n|"type"\s*:\s*"response\.completed"/.test(
            text
          ),
          errorEvent: /event: error|response.failed|unexpected EOF/.test(text)
        }
      } catch {
        return { kind, status: response.status, interrupted: true }
      }
    } finally {
      clearTimeout(timeout)
    }
  }
  const settle = async () => {
    const deadline = Date.now() + 2000
    while (active && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10))
    }
    check(active === 0, 'Cancelled request retained an admission slot')
  }
  const baseline = await snapshot(),
    results = []
  for (let repeat = 0; repeat < 8; repeat++) {
    for (const kind of ['success', '403', '429', 'partial', 'cancel']) {
      const result = await send(kind)
      results.push(result)
      await settle()
      if (kind === 'success') {
        check(
          result.status === 200 && result.bodySeen,
          'SSE success did not preserve synthetic content'
        )
      }
      if (kind === '403' || kind === '429') {
        check(result.status === Number(kind), 'Upstream rejection status changed')
      }
      if (kind === 'partial') {
        check(
          !result.completed && (result.interrupted || result.errorEvent || result.status >= 400),
          `Partial stream outcome: ${JSON.stringify(result)}`
        )
      }
    }
  }
  const jsonSuccess = await send(
    'success',
    JSON.stringify({ model: 'probe', stream: false, input: canary })
  )
  await settle()
  check(
    jsonSuccess.status === 200 &&
      jsonSuccess.bodySeen &&
      jsonSuccess.contentType?.includes('application/json'),
    'Nonstreaming success failed'
  )
  const malformed = await send('success', `{${canary}`)
  await settle()
  const oversized = await send(
    'success',
    JSON.stringify({ model: 'probe', input: canary + 'x'.repeat(20 * 1024) })
  )
  await settle()
  check(malformed.status === 400, 'Malformed JSON was not rejected')
  check(oversized.status === 413, 'Engine request body limit was not enforced')
  const wsStatus = await new Promise((done, reject) => {
    const req = httpRequest(
      `${frontBase}/v1/responses`,
      { headers: { connection: 'Upgrade', upgrade: 'websocket' } },
      (response) => {
        response.resume()
        done(response.statusCode)
      }
    )
    req.once('error', reject)
    req.end()
  })
  check(wsStatus === 426, 'WebSocket upgrade was not rejected')
  const stableFiles = (value) => value.files.filter((file) => file.path !== 'writer-owner.json')
  const sameStorage = (value, live) => {
    const writers = value.files.filter((file) => file.path === 'writer-owner.json')
    check(
      writers.length === (productionLaunch && live ? 1 : 0),
      'Engine writer receipt lifetime is incorrect'
    )
    check(
      writers.every((file) => file.bytes <= 4096),
      'Engine writer receipt exceeded its byte bound'
    )
    check(
      JSON.stringify(stableFiles(value)) === JSON.stringify(stableFiles(baseline)),
      'Engine config or other scratch files grew'
    )
  }
  const repeated = await snapshot()
  sameStorage(repeated, true)
  check(repeated.bytes === baseline.bytes, 'Unchanged live engine storage grew')
  const crashResult = await send('crash')
  await settle()
  const crashed = await snapshot()
  sameStorage(crashed, false)
  await startEngine()
  const restartResult = await send('success')
  await settle()
  check(
    restartResult.status === 200 && restartResult.bodySeen,
    'Restarted engine failed synthetic request'
  )
  const restarted = await snapshot()
  sameStorage(restarted, true)
  await stopEngine()
  const stopped = await snapshot()
  sameStorage(stopped, false)
  receipt = {
    ok: !stdoutCanary,
    mode: productionLaunch ? 'production-discard' : 'raw-standalone',
    binarySha256,
    scenarios: results.length,
    results,
    jsonSuccess,
    malformed,
    oversized,
    wsStatus,
    beforeBodyErrors,
    crashResult,
    peakActive,
    requestLimit,
    responseLimit,
    baseline,
    repeated,
    crashed,
    restarted,
    stopped,
    stdoutBytes: productionLaunch ? null : stdoutBytes,
    stdoutCanary: productionLaunch ? null : stdoutCanary,
    outputPolicy: productionLaunch
      ? 'managed pipes drained without parsing or retention'
      : 'captured in memory for canary audit only',
    stdoutCanaryLines: [...stdoutCanaryLines],
    limits: [
      'HTTP-only; WebSocket rejected, not qualified',
      'No panic injected',
      'Synthetic API keys; no OAuth/refresh ownership proof',
      'Finite probe, no long-running memory guarantee'
    ]
  }
} finally {
  for (const timer of timers) {
    clearTimeout(timer)
  }
  for (const pending of openRequests) {
    pending.destroy()
  }
  await close(front)
  await stopEngine()
  await close(upstream)
  await rm(root, { recursive: true, force: true })
}
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(
  `${JSON.stringify({ ok: receipt.ok, scenarios: receipt.scenarios, bytes: receipt.restarted.bytes, stdoutCanary: receipt.stdoutCanary })}\n`
)

if (!receipt.ok) {
  process.exitCode = 1
}
