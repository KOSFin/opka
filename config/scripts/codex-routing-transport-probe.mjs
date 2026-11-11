import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { spawnProcess } from '@orca/process-host'
import { startSyntheticRoutingEngine } from './codex-routing-probe-engine.mjs'
import { SYNTHETIC_COMPACTION_CIPHERTEXT } from './codex-native-probe-ciphertext.mjs'

const argv = process.argv.slice(2)
const program = argv[argv.indexOf('--codex') + 1]
const output = argv[argv.indexOf('--output') + 1]
const engineProgram = argv.includes('--engine') ? argv[argv.indexOf('--engine') + 1] : undefined
const nativeAuthSwap = argv.includes('--native-auth-swap')
const compactResume = argv.includes('--compact-resume')
const compactOutput = { type: 'compaction', encrypted_content: SYNTHETIC_COMPACTION_CIPHERTEXT }
if (compactResume && (!engineProgram || !argv.includes('--engine-explicit'))) {
  throw new Error('Compact/resume requires the explicit protected engine route')
}
if (!argv.includes('--codex') || !program || !argv.includes('--output') || !output) {
  throw new Error('Pass --codex <absolute executable> --output <report.json>')
}
if (resolve(program) !== program) {
  throw new Error('An explicit absolute Codex executable is required')
}

const root = await mkdtemp(join(tmpdir(), 'opka-codex-routing-'))
const accountHome = join(root, 'codex')
const workspace = join(root, 'workspace')
let child
let lines
let childClosed
let childDidClose = false
let server
let report
let runFailed = false
let cleanupFailure
let engine
const pending = new Map()
try {
  await Promise.all([mkdir(accountHome, { mode: 0o700 }), mkdir(workspace, { mode: 0o700 })])
  let account = 'synthetic-A'
  const requests = []
  let compactResponseSha256
  server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({ data: ['probe-a', 'probe-b'].map((id) => ({ id, object: 'model' })) })
        )
        return
      }
      const remoteCompact = request.url === '/v1/responses/compact'
      if (request.method !== 'POST' || (!remoteCompact && request.url !== '/v1/responses')) {
        response.writeHead(404).end()
        return
      }
      let body = ''
      for await (const chunk of request) {
        body += chunk
        if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
          throw new Error('Synthetic input exceeded limit')
        }
      }
      const input = JSON.parse(body)
      const metadata = request.headers['x-codex-turn-metadata']
      const compactionRequest =
        remoteCompact ||
        (typeof metadata === 'string' && JSON.parse(metadata).request_kind === 'compaction')
      const routedAccount =
        engine || nativeAuthSwap ? request.headers.authorization?.replace('Bearer ', '') : account
      const text = compactionRequest
        ? 'SYNTHETIC_COMPACTED_CONTEXT'
        : routedAccount === 'synthetic-A'
          ? 'PROBE_A'
          : 'PROBE_B'
      const compactItems = Array.isArray(input.input)
        ? input.input.filter((item) => item?.type === 'compaction')
        : []
      requests.push({
        account: routedAccount,
        model: input.model,
        kind: remoteCompact ? 'remote-compact' : compactionRequest ? 'local-compact' : 'turn',
        bodyBytes: Buffer.byteLength(body),
        bodySha256: createHash('sha256').update(body).digest('hex'),
        opaqueCompactInInput:
          compactItems.length === 1 &&
          compactItems[0].encrypted_content === SYNTHETIC_COMPACTION_CIPHERTEXT &&
          Object.keys(compactItems[0]).every((key) => Object.hasOwn(compactOutput, key)),
        localCompactInInput: JSON.stringify(input.input ?? []).includes(
          'SYNTHETIC_COMPACTED_CONTEXT'
        ),
        previousResponseIdPresent: typeof input.previous_response_id === 'string',
        priorReplyInInput:
          Array.isArray(input.input) &&
          input.input.some(
            (item) =>
              item.role === 'assistant' &&
              Array.isArray(item.content) &&
              item.content.some((part) => part.text === 'PROBE_A')
          ),
        stream: input.stream
      })
      if (remoteCompact) {
        const compactResponse = JSON.stringify({
          id: 'cmp_synthetic',
          object: 'response.compaction',
          created_at: 1,
          output: [compactOutput]
        })
        compactResponseSha256 = createHash('sha256').update(compactResponse).digest('hex')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(compactResponse)
        return
      }
      const id = `resp_probe_${requests.length}`
      const item = {
        id: `msg_probe_${requests.length}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }]
      }
      const complete = {
        id,
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: input.model,
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const events = [
        ['response.created', { response: { ...complete, status: 'in_progress', output: [] } }],
        [
          'response.output_item.added',
          { output_index: 0, item: { ...item, status: 'in_progress', content: [] } }
        ],
        [
          'response.content_part.added',
          {
            output_index: 0,
            item_id: item.id,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] }
          }
        ],
        [
          'response.output_text.delta',
          { output_index: 0, item_id: item.id, content_index: 0, delta: text }
        ],
        [
          'response.output_text.done',
          { output_index: 0, item_id: item.id, content_index: 0, text }
        ],
        [
          'response.content_part.done',
          { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] }
        ],
        ['response.output_item.done', { output_index: 0, item }],
        ['response.completed', { response: complete }]
      ]
      events.forEach(([type, payload], sequence_number) => {
        response.write(
          `event: ${String(type)}\ndata: ${JSON.stringify({ type, sequence_number, ...payload })}\n\n`
        )
      })
      response.end()
    } catch {
      if (!response.headersSent) {
        response.writeHead(400)
      }
      response.end()
    }
  })
  await new Promise((ready, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', ready)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Synthetic endpoint unavailable')
  }
  const env = Object.fromEntries(
    ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG']
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]])
  )
  if (engineProgram) {
    engine = await startSyntheticRoutingEngine({
      program: engineProgram,
      root,
      upstream: `http://127.0.0.1:${address.port}/v1`,
      env,
      explicit: argv.includes('--engine-explicit')
    })
  }
  await writeFile(
    join(accountHome, 'config.toml'),
    [
      'model = "probe-a"',
      'model_provider = "opka_probe"',
      'cli_auth_credentials_store = "file"',
      '[model_providers.opka_probe]',
      'name = "Synthetic Opka routing"',
      `base_url = "${engine?.baseUrl ?? `http://127.0.0.1:${address.port}/v1`}"`,
      'wire_api = "responses"',
      `requires_openai_auth = ${nativeAuthSwap}`,
      ...(nativeAuthSwap ? [] : ['env_key = "OPKA_PROBE_KEY"']),
      'supports_websockets = false',
      ''
    ].join('\n'),
    { mode: 0o600 }
  )
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: accountHome,
    OPKA_PROBE_KEY: 'synthetic-no-real-account',
    CODEX_DISABLE_TELEMETRY: '1'
  })
  let notifications = []
  let nextId = 0
  let stderrBytes = 0
  let startFailure
  const launchCodex = () => {
    startFailure = undefined
    notifications = []
    child = spawnProcess({ program, args: ['app-server'], cwd: workspace, env, stdio: 'pipe' })
    childDidClose = false
    childClosed = new Promise((resolveClose) => {
      child.once('close', (code, signal) => {
        childDidClose = true
        resolveClose({ code, signal })
      })
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
    })
    child.on('error', (error) => {
      startFailure = error
    })
    child.stdin.on('error', (error) => {
      startFailure = error
    })
    lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      if (line.length > 256 * 1024) {
        return
      }
      try {
        const value = JSON.parse(line)
        if (pending.has(value.id)) {
          const waiter = pending.get(value.id)
          pending.delete(value.id)
          clearTimeout(waiter.timer)
          if (value.error) {
            waiter.reject(new Error(`Codex rejected RPC: ${JSON.stringify(value.error)}`))
          } else {
            waiter.resolve(value.result)
          }
        } else if (value.method && notifications.length < 5000) {
          notifications.push(value)
        }
      } catch {
        /* Only complete JSON protocol messages are observations. */
      }
    })
  }
  const rpc = (method, params) =>
    new Promise((resolveCall, reject) => {
      if (startFailure || !child.pid || child.exitCode !== null) {
        reject(new Error('Synthetic Codex process unavailable'))
        return
      }
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Synthetic RPC timed out: ${method}`))
      }, 30_000)
      pending.set(id, { resolve: resolveCall, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  const waitTurn = async (turnId) => {
    const deadline = Date.now() + 35_000
    while (Date.now() < deadline) {
      const done = notifications.find(
        (event) => event.method === 'turn/completed' && event.params?.turn?.id === turnId
      )
      if (done) {
        if (done.params.turn.status !== 'completed') {
          throw new Error('Synthetic turn did not complete')
        }
        return
      }
      if (child.exitCode !== null) {
        throw new Error('Codex exited during the synthetic turn')
      }
      await new Promise((resume) => setTimeout(resume, 25))
    }
    throw new Error('Synthetic turn timed out')
  }
  const waitCompact = async (threadId, firstNotification) => {
    const deadline = Date.now() + 35_000
    while (Date.now() < deadline) {
      const events = notifications.slice(firstNotification)
      const compacted = events.some(
        (event) => event.method === 'thread/compacted' && event.params?.threadId === threadId
      )
      const completed = events.find(
        (event) => event.method === 'turn/completed' && event.params?.threadId === threadId
      )
      if (completed && completed.params.turn.status !== 'completed') {
        throw new Error('Public Codex compaction turn failed')
      }
      if (compacted && completed) {
        return
      }
      if (child.exitCode !== null) {
        throw new Error('Codex exited during compaction')
      }
      await new Promise((resume) => setTimeout(resume, 25))
    }
    throw new Error('Public Codex did not confirm compaction completion')
  }
  const initialize = async () => {
    await rpc('initialize', {
      clientInfo: { name: 'opka_routing_probe', version: '1.0.0' },
      capabilities: { experimentalApi: true }
    })
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
  }
  launchCodex()
  await initialize()
  if (nativeAuthSwap) {
    await rpc('account/login/start', { type: 'apiKey', apiKey: 'synthetic-A' })
  }
  const thread = await rpc('thread/start', {
    model: 'probe-a',
    cwd: workspace,
    approvalPolicy: 'never',
    sandbox: 'read-only'
  })
  const first = await rpc('turn/start', {
    threadId: thread.thread.id,
    input: [{ type: 'text', text: 'Return PROBE_A.' }]
  })
  await waitTurn(first.turn.id)
  account = 'synthetic-B'
  await engine?.switchToB()
  if (nativeAuthSwap) {
    await rpc('account/login/start', { type: 'apiKey', apiKey: 'synthetic-B' })
  }
  const second = await rpc('turn/start', {
    threadId: thread.thread.id,
    model: 'probe-b',
    input: [{ type: 'text', text: 'Return PROBE_B and retain the prior exchange.' }]
  })
  await waitTurn(second.turn.id)
  if (
    requests.length !== 2 ||
    requests[0].account !== 'synthetic-A' ||
    requests[1].account !== 'synthetic-B'
  ) {
    throw new Error(`Synthetic account routing mismatch: ${JSON.stringify(requests)}`)
  }
  if (requests[1].model !== 'probe-b' || !requests[1].priorReplyInInput) {
    throw new Error('Model change or retained input history was not observed')
  }
  let compactEvidence
  if (compactResume) {
    const firstNotification = notifications.length
    await rpc('thread/compact/start', { threadId: thread.thread.id })
    await waitCompact(thread.thread.id, firstNotification)
    const compact = requests[2]
    if (!compact || compact.kind !== 'remote-compact' || compact.stream !== false) {
      throw new Error('Public CLI did not request complete remote opaque compaction')
    }
    const next = await rpc('turn/start', {
      threadId: thread.thread.id,
      input: [{ type: 'text', text: 'Use the compacted context and return PROBE_B.' }]
    })
    await waitTurn(next.turn.id)
    if (requests.length !== 4 || !requests[3].opaqueCompactInInput) {
      throw new Error('Complete opaque compaction was absent from the next public request')
    }
    lines.close()
    const exiting = child
    exiting.stdin.end()
    if (!childDidClose) {
      exiting.kill('SIGTERM')
    }
    const force = setTimeout(() => exiting.kill('SIGKILL'), 2000)
    let deadline
    const closed = await Promise.race([
      childClosed,
      new Promise((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error('First public app-server close timed out')),
          5000
        )
      })
    ]).finally(() => {
      clearTimeout(force)
      clearTimeout(deadline)
    })
    if (closed.code !== 0 && closed.signal !== 'SIGTERM') {
      throw new Error('First public app-server did not exit after the compacted turn')
    }
    launchCodex()
    await initialize()
    if (nativeAuthSwap) {
      await rpc('account/login/start', { type: 'apiKey', apiKey: 'synthetic-B' })
    }
    const resumed = await rpc('thread/resume', {
      threadId: thread.thread.id,
      excludeTurns: true
    })
    if (resumed.thread?.id !== thread.thread.id) {
      throw new Error('Public CLI resumed a different thread')
    }
    const resumedTurn = await rpc('turn/start', {
      threadId: thread.thread.id,
      input: [{ type: 'text', text: 'Retain compacted context after process restart.' }]
    })
    await waitTurn(resumedTurn.turn.id)
    if (requests.length !== 5 || !requests[4].opaqueCompactInInput) {
      throw new Error('Opaque compaction was absent after public CLI process restart and resume')
    }
    compactEvidence = {
      remoteRequestSha256: compact.bodySha256,
      remoteRequestBytes: compact.bodyBytes,
      nextRequestSha256: requests[3].bodySha256,
      resumedRequestSha256: requests[4].bodySha256,
      opaqueCiphertextSha256: createHash('sha256')
        .update(SYNTHETIC_COMPACTION_CIPHERTEXT)
        .digest('hex'),
      completeProviderResponseSha256: compactResponseSha256,
      threadIdPreserved: true,
      processRestarted: true,
      nextAndResumedOpaqueContent: true,
      physicalLeaseUntilPositiveExit: 'UNPROVEN',
      retryByteIdentity: 'UNPROVEN'
    }
  }
  report = {
    passed: true,
    scope: engine
      ? 'real Codex app-server and CLIProxyAPI with synthetic accounts; not a real subscription test'
      : 'real Codex app-server core with synthetic HTTP/SSE upstream; not a real account or third-party router test',
    sameProcess: !compactResume,
    explicitAccountRoute: argv.includes('--engine-explicit'),
    nativeAuthRpcSwap: nativeAuthSwap,
    compactEvidence,
    requests,
    stderrBytes
  }
} catch (error) {
  runFailed = true
  throw error
} finally {
  const cleanupFailures = []
  const cleanupStep = async (action, timeoutMs = 5000) => {
    let deadline
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Synthetic cleanup timed out')), timeoutMs)
        })
      ])
    } catch (error) {
      cleanupFailures.push(error)
    } finally {
      clearTimeout(deadline)
    }
  }
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer)
    waiter.reject(new Error('Synthetic probe stopped'))
  }
  await cleanupStep(() => lines?.close())
  await cleanupStep(() => child?.stdin?.end())
  await cleanupStep(async () => {
    if (child?.pid && !childDidClose) {
      const exiting = child
      exiting.kill('SIGTERM')
      const force = setTimeout(() => exiting.kill('SIGKILL'), 2000)
      let deadline
      await Promise.race([
        childClosed,
        new Promise((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Public app-server close timed out')), 5000)
        })
      ]).finally(() => {
        clearTimeout(force)
        clearTimeout(deadline)
      })
    }
  })
  await cleanupStep(() => engine?.stop(), 10000)
  await cleanupStep(() => server?.closeAllConnections())
  await cleanupStep(async () => {
    if (server?.listening) {
      await new Promise((done) => server.close(done))
    }
  })
  const files = await readdir(accountHome).catch(() => [])
  await cleanupStep(() => rm(root, { recursive: true, force: true }))
  if (report) {
    report.isolatedHomeCleaned = files.length >= 1 && cleanupFailures.length === 0
  }
  if (cleanupFailures.length) {
    if (runFailed) {
      console.error('Synthetic probe cleanup also failed:', cleanupFailures)
    } else {
      cleanupFailure = new AggregateError(cleanupFailures, 'Synthetic probe cleanup failed')
    }
  }
}
if (cleanupFailure) {
  throw cleanupFailure
}
await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify(report))
