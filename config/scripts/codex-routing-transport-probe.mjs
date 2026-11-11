import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { spawnProcess } from '@orca/process-host'
import { startSyntheticRoutingEngine } from './codex-routing-probe-engine.mjs'
import { createSyntheticRoutingUpstream } from './codex-routing-probe-upstream.mjs'
import { SYNTHETIC_COMPACTION_CIPHERTEXT } from './codex-native-probe-ciphertext.mjs'

const argv = process.argv.slice(2)
const program = argv[argv.indexOf('--codex') + 1]
const output = argv[argv.indexOf('--output') + 1]
const engineProgram = argv.includes('--engine') ? argv[argv.indexOf('--engine') + 1] : undefined
const nativeAuthSwap = argv.includes('--native-auth-swap')
const compactResume = argv.includes('--compact-resume')
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
/** @type {Promise<{code: number | null, signal: string | null}> | undefined} */
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
  const upstream = createSyntheticRoutingUpstream({
    requests,
    nativeAuthSwap,
    getEngine: () => engine,
    getAccount: () => account
  })
  server = upstream.server
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
      ...(compactResume
        ? ['[model_providers.opka_probe.capabilities]', 'remote_compaction = "v2"']
        : []),
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
    const compactDiagnostic = () => {
      const events = notifications.slice(firstNotification)
      console.error(
        'Synthetic compact diagnostic:',
        JSON.stringify({
          notificationCount: events.length,
          notifications: events.slice(-64).map((event) => ({
            method: typeof event.method === 'string' ? event.method.slice(0, 80) : undefined,
            threadMatches: event.params?.threadId === threadId,
            itemType:
              event.params?.item?.type === 'contextCompaction' ? 'contextCompaction' : undefined,
            turnStatus: ['inProgress', 'completed', 'failed', 'interrupted'].includes(
              event.params?.turn?.status
            )
              ? event.params.turn.status
              : undefined
          })),
          requestCount: requests.length,
          requests: requests
            .slice(-64)
            .map(({ kind, bodyBytes, triggerCount }) => ({ kind, bodyBytes, triggerCount })),
          childExitCode: child.exitCode,
          childSignal: child.signalCode,
          stderrBytes,
          engineOutputBytes: engine?.outputBytes()
        })
      )
    }
    const deadline = Date.now() + 35_000
    while (Date.now() < deadline) {
      const events = notifications.slice(firstNotification)
      const compacted = events.some(
        (event) =>
          event.method === 'item/completed' &&
          event.params?.threadId === threadId &&
          event.params?.item?.type === 'contextCompaction'
      )
      const completed = events.find(
        (event) => event.method === 'turn/completed' && event.params?.threadId === threadId
      )
      if (completed && completed.params.turn.status !== 'completed') {
        compactDiagnostic()
        throw new Error('Public Codex compaction turn failed')
      }
      if (compacted && completed) {
        return
      }
      if (child.exitCode !== null) {
        compactDiagnostic()
        throw new Error('Codex exited during compaction')
      }
      await new Promise((resume) => setTimeout(resume, 25))
    }
    compactDiagnostic()
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
    const reportRequestBoundary = () => {
      console.error(
        'Synthetic compact request boundary:',
        JSON.stringify({
          requestCount: requests.length,
          requests: requests.slice(-64).map((request) => ({
            kind: request.kind,
            bodyBytes: request.bodyBytes,
            triggerCount: request.triggerCount,
            opaqueCompactItemCount: request.opaqueCompactItemCount,
            opaqueCiphertextMatches: request.opaqueCiphertextMatches,
            opaqueCiphertextSha256: request.opaqueCiphertextSha256,
            opaqueCiphertextBytes: request.opaqueCiphertextBytes,
            opaqueCompactKnownKeys: request.opaqueCompactKnownKeys,
            opaqueCompactUnknownKeyCount: request.opaqueCompactUnknownKeyCount,
            opaqueCompactInInput: request.opaqueCompactInInput,
            previousResponseIdPresent: request.previousResponseIdPresent,
            localCompactInInput: request.localCompactInInput
          }))
        })
      )
    }
    const firstNotification = notifications.length
    await rpc('thread/compact/start', { threadId: thread.thread.id })
    try {
      await waitCompact(thread.thread.id, firstNotification)
    } catch (error) {
      reportRequestBoundary()
      throw error
    }
    const compact = requests[2]
    if (
      !compact ||
      compact.kind !== 'remote-v2-compact' ||
      compact.stream !== true ||
      compact.triggerCount !== 1
    ) {
      reportRequestBoundary()
      throw new Error('Public CLI did not request complete remote opaque compaction')
    }
    if (!compact.priorReplyInInput || !compact.secondReplyInInput) {
      reportRequestBoundary()
      throw new Error('Remote compaction omitted the original conversation window')
    }
    const next = await rpc('turn/start', {
      threadId: thread.thread.id,
      input: [{ type: 'text', text: 'Use the compacted context and return PROBE_B.' }]
    })
    try {
      await waitTurn(next.turn.id)
    } catch (error) {
      reportRequestBoundary()
      throw error
    }
    if (requests.length !== 4 || !requests[3].opaqueCompactInInput) {
      reportRequestBoundary()
      throw new Error('Complete opaque compaction was absent from the next public request')
    }
    lines.close()
    const exiting = child
    exiting.stdin.end()
    let termSent = false
    if (!childDidClose) {
      termSent = exiting.kill('SIGTERM')
    }
    if (!childClosed) {
      throw new Error('First public app-server close promise was not installed')
    }
    let forceSent = false
    const force = setTimeout(() => {
      if (!childDidClose) {
        forceSent = exiting.kill('SIGKILL')
      }
    }, 2000)
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
    if (
      closed.code !== 0 &&
      !(closed.signal === 'SIGTERM' && termSent) &&
      !(closed.signal === 'SIGKILL' && forceSent)
    ) {
      console.error(
        'Synthetic first app-server close verdict:',
        JSON.stringify({
          code: closed.code,
          signal: closed.signal,
          termSent,
          forceSent,
          stderrBytes
        })
      )
      throw new Error('First public app-server did not exit after the compacted turn')
    }
    launchCodex()
    await initialize()
    if (nativeAuthSwap) {
      await rpc('account/login/start', { type: 'apiKey', apiKey: 'synthetic-B' })
    }
    let resumed
    try {
      resumed = await rpc('thread/resume', {
        threadId: thread.thread.id,
        excludeTurns: true
      })
    } catch (error) {
      reportRequestBoundary()
      throw error
    }
    if (resumed.thread?.id !== thread.thread.id) {
      reportRequestBoundary()
      throw new Error('Public CLI resumed a different thread')
    }
    const resumedTurn = await rpc('turn/start', {
      threadId: thread.thread.id,
      input: [{ type: 'text', text: 'Retain compacted context after process restart.' }]
    })
    try {
      await waitTurn(resumedTurn.turn.id)
    } catch (error) {
      reportRequestBoundary()
      throw error
    }
    if (requests.length !== 5 || !requests[4].opaqueCompactInInput) {
      reportRequestBoundary()
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
      completeProviderResponseSha256: upstream.completeResponseSha256(),
      threadIdPreserved: true,
      processRestarted: true,
      firstProcessClose: {
        code: closed.code,
        signal: closed.signal,
        ownedTermKill: termSent,
        ownedForcedKill: forceSent
      },
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
      if (!childClosed) {
        throw new Error('Public app-server close promise was not installed')
      }
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
