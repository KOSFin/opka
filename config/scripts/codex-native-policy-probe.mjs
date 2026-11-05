import {
  readNativeProbeInputs,
  assertSyntheticOpenAiProviderAbsent,
  nativeProbeRoutingPlan
} from './codex-native-probe-configuration.mjs'
import { parse } from 'smol-toml'
import { SYNTHETIC_COMPACTION_CIPHERTEXT } from './codex-native-probe-ciphertext.mjs'
import {
  writeNativeProbeResponse,
  writeNativeProbePartialResponse
} from './codex-native-probe-response.mjs'
import {
  collectNativeProbeRollouts,
  printNativeProbeResult,
  summarizeNativeProbeRequests,
  captureNativeProbeRequests,
  verifyNativeProbeRequests
} from './codex-native-probe-evidence.mjs'
import {
  codexNativeProbeArguments,
  readNativeProbeModes,
  nativeProbeScope
} from './codex-native-probe-arguments.mjs'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { spawnProcess } from '@orca/process-host'
import { redactTranscript } from './pty-transcript-secret-scan.mjs'

const { codex, enginePath, output, ptyModule } = await readNativeProbeInputs(process.argv)
const check = (value, message) => {
  if (!value) {
    throw new Error(message)
  }
}
const {
  builtinOpenai,
  resumeMode,
  cancelMode,
  approvalCapture,
  approval,
  catalogPath,
  compactMode,
  encryptedModel,
  toolQuota,
  execQuota,
  newConversation,
  vision
} = readNativeProbeModes(process.argv)
const root = await mkdtemp(join(dirname(output), 'native-policy-scratch-'))
let upstream,
  front,
  engine,
  recorder,
  hooks,
  db,
  authTrap,
  gateway,
  detach,
  boundary,
  unsub,
  authority,
  retireOwner,
  rateLimits
let report = {
  ok: false,
  scope: execQuota
    ? 'actual external native exec; production front/session/engine and owned-cap trusted-HOME transcript source; no PTY'
    : 'ordinary pinned native PTY; production front/session/engine and authentic hook ingestion; synthetic account and PTY owner fixture'
}
const requests = [],
  hookRows = []
const listen = async (server) => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}
try {
  const home = join(root, 'codex'),
    workspace = join(root, 'workspace'),
    app = join(root, 'app')
  await Promise.all([home, workspace, app].map((path) => mkdir(path, { mode: 0o700 })))
  Object.assign(process.env, { HOME: root, USERPROFILE: root, CODEX_HOME: home })
  const { setAppEnvironment } = await import('../../src/shared/app-environment.ts')
  setAppEnvironment({
    getPath: () => app,
    getAppPath: () => root,
    getVersion: () => '0.0.0-synthetic',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  const { startEngineRuntime } = await import('../../src/main/codex-routing/engine-runtime.ts')
  const { createCodexRoutingHttpServer } =
    await import('../../src/main/codex-routing/codex-routing-http-server.ts')
  const { CodexEngineSessions } =
    await import('../../src/main/codex-routing/codex-engine-sessions.ts')
  const { OrchestrationDb } =
    await import('../../src/main/runtime/orchestration/db/orchestration-db.ts')
  const { agentHookServer } = await import('../../src/main/agent-hooks/server.ts')
  const { AgentTransitionDetector } =
    await import('../../src/main/agent-hooks/agent-transition-detector.ts')
  const { createNativeCliTurnBoundary } =
    await import('../../src/main/runtime/native-cli-turn-boundary.ts')
  const pane = 'synthetic-tab:11111111-1111-4111-8111-111111111111'
  hooks = agentHookServer
  await hooks.start({ env: 'production', userDataPath: app, endpointNamespace: 'synthetic-native' })
  const transitions = new AgentTransitionDetector({
    resolveTabWorktreeId: () => 'synthetic-workspace',
    subscribeToPtyExit: () => () => {},
    now: Date.now
  })
  detach = transitions.attach(hooks)
  const { createNativeCodexSessionAuthority } =
    await import('../../src/main/runtime/native-codex-session-authority.ts')
  const {
    registerNativeCodexRoutingOwner,
    revokeNativeCodexRoutingLaunch,
    selectNativeCodexRoutingAccount
  } = await import('../../src/main/runtime/native-codex-routing-ownership.ts')
  db = new OrchestrationDb(':memory:')
  const runtime = {
    agentTransitions: transitions,
    getOrchestrationDb: () => db,
    getPtyExecutionHostMetadata: () => ({ incarnationId: 'synthetic-incarnation' }),
    subscribeToPtyExit: () => () => {}
  }
  const launchId = randomUUID()
  let native
  const readOwner = () =>
    execQuota
      ? null
      : { paneKey: pane, ptyId: 'synthetic-owned-pty', incarnationId: 'synthetic-incarnation' }
  authority = createNativeCodexSessionAuthority(
    runtime,
    launchId,
    readOwner,
    home,
    () => native?.readActiveRequests() === 0
  )
  let rootSession = null
  const startedAt = Date.now()
  boundary = createNativeCliTurnBoundary({
    provider: 'codex',
    expectedSessionId: authority.expectedSessionId,
    launchStartedAt: startedAt,
    transitions,
    readNativeOwner: authority.readNativeOwner,
    readNativeChildren: authority.readNativeChildren,
    readRetainedNativeBoundary: authority.readRetainedNativeBoundary
  })
  const policy = {
    id: 'synthetic-pool',
    provider: 'codex',
    revision: 1,
    strategy: 'sequential',
    rotation: execQuota ? 'on-limit' : 'after-turn',
    applyToNewWork: true,
    unknownQuota: execQuota ? 'allow' : 'exclude',
    allowReserve: false,
    members: ['A', 'B'].map((accountId) => ({
      accountId,
      priority: 1,
      weight: 1,
      maxConcurrent: 1,
      state: 'enabled',
      role: 'primary'
    }))
  }
  let changed = false
  unsub = hooks.subscribeStatusRowMutations(() => {
    const row = transitions.latestRow(pane)
    if (row?.providerSession?.id && hookRows.length < 64) {
      hookRows.push({
        sessionId: row.providerSession.id,
        state: row.state,
        executionId: row.executionId,
        at: row.receivedAt,
        interrupted: row.interrupted
      })
    }
    if (cancelMode && row?.interrupted && row.providerSession?.id === rootSession) {
      report.authenticNativeInterrupt = true
    }
    if (
      approval &&
      rootSession &&
      row?.state === 'waiting' &&
      row.providerSession?.id === rootSession &&
      !report.authenticApprovalBlocked
    ) {
      report.authenticApprovalBlocked = true
      report.quotaReplaceAllowedDuringApproval = authority.canReplaceRejectedRequest()
      policy.revision++
      policy.members[1].priority = 0
      changed = true
      report.policyChangedWhileBlocked = true
    }
    if (
      !execQuota &&
      !changed &&
      row?.state === 'done' &&
      rootSession &&
      row.providerSession?.id === rootSession &&
      boundary.canSwitch()
    ) {
      policy.revision++
      policy.members[1].priority = 0
      changed = true
    }
  })
  upstream = createServer(async (req, res) => {
    if (req.method !== 'POST' || !['/v1/responses', '/v1/responses/compact'].includes(req.url)) {
      res.writeHead(404).end()
      return
    }
    const chunks = []
    let size = 0
    for await (const bytes of req) {
      size += bytes.length
      if (size > 1024 * 1024) {
        res.writeHead(413).end()
        return
      }
      chunks.push(bytes)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    check(requests.length < 8, 'Unexpected native request loop')
    const account = req.headers.authorization?.replace('Bearer ', '')
    requests.push({
      account,
      model: body.model,
      path: req.url,
      metadata: req.headers['x-codex-turn-metadata'],
      input: body.input,
      requestKeys: Object.keys(body),
      toolNames: body.tools?.map((tool) => tool.name ?? tool.function?.name)
    })
    if (cancelMode && requests.length === 1) {
      writeNativeProbePartialResponse(res, body, report)
      return
    }
    const compactionRequest =
      req.url.endsWith('/compact') ||
      (req.headers['x-codex-turn-metadata'] &&
        JSON.parse(req.headers['x-codex-turn-metadata']).request_kind === 'compaction')
    if (req.url.endsWith('/compact')) {
      report.compactionImplementation = 'remote-json'
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'cmp_synthetic',
          object: 'response.compaction',
          created_at: 1,
          output: [{ type: 'compaction', encrypted_content: SYNTHETIC_COMPACTION_CIPHERTEXT }]
        })
      )
      return
    }
    if (compactionRequest) {
      report.compactionImplementation = 'local-responses'
    }
    if (execQuota && account === 'synthetic-A' && (!toolQuota || requests.length > 1)) {
      res.writeHead(429, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error: {
            code: 'usage_limit_reached',
            type: 'usage_limit_reached',
            message: 'Synthetic confirmed limit'
          }
        })
      )
      return
    }
    writeNativeProbeResponse(
      res,
      body,
      account,
      requests.length,
      (toolQuota || approval) && requests.length === 1,
      (encryptedModel || compactMode || resumeMode) &&
        account === 'synthetic-A' &&
        JSON.parse(req.headers['x-codex-turn-metadata']).thread_source !== 'thread_title',
      compactionRequest,
      approval
    )
  })
  const upstreamPort = await listen(upstream)
  const reserve = createServer()
  const enginePort = await listen(reserve)
  await new Promise((done) => reserve.close(done))
  engine = await startEngineRuntime({
    binaryPath: enginePath,
    expectedSha256: '7079cd5a49adbe127f957db7528b5a002e6f9076f48b13c99864c6196ae7dba9',
    memoryMiB: 128,
    directory: join(root, 'engine'),
    port: enginePort,
    maxRequestBytes: 1024 * 1024,
    auth: {
      kind: 'synthetic-test',
      upstream: `http://127.0.0.1:${upstreamPort}/v1`,
      accounts: ['A', 'B']
    },
    assertExclusiveRuntimeDirectory: () => {},
    networkProxySettings: null
  })
  const { createSyntheticCodexQuotaAuthority } =
    await import('./codex-native-probe-quota-authority.mjs')
  const quota = execQuota ? await createSyntheticCodexQuotaAuthority(home, report) : null
  rateLimits = quota
  const candidates =
    quota?.candidates ??
    (() =>
      ['A', 'B'].map((accountId) => ({
        accountId,
        quotaIdentity: accountId,
        auth: 'ready',
        quota: 'available',
        usedPercent: 1
      })))
  const recordQuotaFailure = quota?.record
  const sessions = new CodexEngineSessions({
    db,
    readState: () => ({
      policy,
      candidates: candidates(),
      manualAccountId: null
    }),
    route: (accountId) => ({
      port: engine.port,
      clientKey: engine.clientKey,
      prefix: `synthetic-${accountId}`
    }),
    accepting: () => true,
    recordQuotaFailure
  })
  native = sessions.register({
    launchId,
    ownerPrefix: 'synthetic-native',
    canSwitch: boundary.canSwitch,
    readBoundary: (next) => {
      const snapshot = boundary.snapshot()
      return authority.boundary(snapshot, next)
    },
    onRootThreadBound: (id, context) => {
      rootSession = id
      authority.bindRoot(id, context)
    },
    onRootTurnAccepted: authority.onRootTurnAccepted,
    areRetainedTurnsSettled: authority.areRetainedTurnsSettled,
    canReplaceRejectedRequest: authority.canReplaceRejectedRequest,
    prepareQuotaRetry: authority.prepareQuotaRetry,
    onAccountSelected: (selection) => selectNativeCodexRoutingAccount(runtime, launchId, selection)
  })
  registerNativeCodexRoutingOwner(runtime, launchId, {
    readOwner,
    revoke: native.revoke,
    dispose: authority.dispose,
    routingKey: native.apiKey
  })
  retireOwner = () => revokeNativeCodexRoutingLaunch(runtime, launchId)
  if (builtinOpenai) {
    gateway = (await import('./codex-native-probe-gateway.mjs')).createNativeProbeGateway(
      report,
      join(root, 'native-gateway-profile')
    )
  }
  front = createCodexRoutingHttpServer({
    nativeClientKey: gateway?.apiKey,
    maxConcurrent: 2,
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
    responseHeaderTimeoutMs: 5000,
    prepare: sessions.prepare,
    onCleanupUnverifiable: () => {
      report.cleanupUnverifiable = true
    }
  })
  captureNativeProbeRequests(front, report)
  const frontPort = await listen(front)
  const { writeNativeProbeConfiguration } = await import('./codex-native-probe-configuration.mjs')
  await writeNativeProbeConfiguration({
    root,
    home,
    workspace,
    frontPort,
    knownModel: vision || compactMode || encryptedModel || approval || cancelMode || resumeMode,
    catalogPath
  })
  if (process.argv.includes('--expired-auth-trap') || builtinOpenai) {
    const { createNativeProbeAuthTrap } = await import('./codex-native-probe-auth-trap.mjs')
    authTrap = await createNativeProbeAuthTrap(home, report, builtinOpenai ? gateway.apiKey : null)
  }
  await (
    await import('./codex-native-probe-status-hooks.mjs')
  ).prepareNativeProbeStatusHooks({ root, home, executable: codex, report })
  const transcript = `${output}.txt`
  const env = Object.fromEntries(
    ['PATH', 'LANG']
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]])
  )
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: home,
    OPKA_SYNTHETIC_FRONT_KEY: native.apiKey,
    ORCA_CAPTURE_NODE_PTY_MODULE: ptyModule,
    ...hooks.buildPtyEnv(),
    ORCA_PANE_KEY: pane,
    ORCA_TAB_ID: 'synthetic-tab',
    ORCA_WORKTREE_ID: 'synthetic-workspace',
    ORCA_AGENT_LAUNCH_TOKEN: randomUUID(),
    ORCA_BACKGROUND_LAUNCH: '1',
    CODEX_DISABLE_TELEMETRY: '1',
    ...authTrap?.env
  })
  if (execQuota) {
    delete env.ORCA_PANE_KEY
    delete env.ORCA_TAB_ID
    delete env.ORCA_WORKTREE_ID
    delete env.ORCA_AGENT_LAUNCH_TOKEN
  }
  if (builtinOpenai) {
    await assertSyntheticOpenAiProviderAbsent(home, workspace)
  }
  const routingPlan =
    resumeMode || authTrap
      ? nativeProbeRoutingPlan(
          {
            baseUrl: `http://127.0.0.1:${frontPort}/v1`,
            apiKey: native.apiKey
          },
          builtinOpenai,
          gateway
        )
      : null
  if (routingPlan) {
    Object.assign(env, routingPlan.env)
  }
  const imagePath = join(workspace, 'synthetic.png')
  if (vision) {
    const { syntheticNativeProbeImage } = await import('./codex-native-probe-image.mjs')
    await writeFile(imagePath, syntheticNativeProbeImage())
  }
  await writeFile(transcript, '', { mode: 0o600 })
  recorder = spawnProcess({
    program: execQuota ? codex : process.execPath,
    args: codexNativeProbeArguments({
      execQuota,
      toolQuota,
      newConversation,
      encryptedModel,
      compactMode,
      approval,
      approvalCapture,
      cancelMode,
      resumeMode,
      builtinOpenai,
      routingPlan,
      vision,
      workspace,
      transcript,
      codex,
      imagePath
    }),
    env,
    stdio: ['ignore', execQuota ? 'pipe' : 'ignore', 'pipe']
  })
  let nativeOutput = ''
  if (execQuota) {
    recorder.stdout.on('data', (bytes) => {
      if (nativeOutput.length < 1024 * 1024) {
        nativeOutput += bytes.toString().slice(0, 1024 * 1024 - nativeOutput.length)
      }
    })
  }
  const captureTimeout = setTimeout(() => recorder.kill('SIGKILL'), cancelMode ? 26000 : 20000)
  let diagnostic = ''
  recorder.stderr.on('data', (bytes) => {
    if (diagnostic.length < 4096) {
      diagnostic += bytes.toString().slice(0, 4096 - diagnostic.length)
    }
  })
  const [captureExit] = await once(recorder, 'close')
  clearTimeout(captureTimeout)
  if (execQuota) {
    await writeFile(transcript, redactTranscript(nativeOutput + diagnostic).text, { mode: 0o600 })
  }
  report.captureExit = captureExit
  check(captureExit === 0, `Native capture failed: ${redactTranscript(diagnostic).text}`)
  check((await stat(transcript)).size < 1024 * 1024, 'Transcript exceeded budget')
  const raw = await readFile(transcript, 'utf8')
  check(Buffer.byteLength(raw) < 1024 * 1024, 'Transcript exceeded budget')
  await writeFile(transcript, redactTranscript(raw).text, { mode: 0o600 })
  if (resumeMode) {
    const firstProvider = parse(routingPlan.codexConfigOverrides.join('\n')).model_provider
    await retireOwner()
    gateway?.revoke(native.apiKey)
    if (gateway) {
      await gateway.assertRetiredRejected(native.apiKey)
    }
    const { runNativeResumeProbe } = await import('./codex-native-probe-resume.mjs')
    const resumed = await runNativeResumeProbe({
      binary: codex,
      builtinOpenai,
      gateway,
      home,
      workspace,
      frontPort,
      sessions,
      runtime,
      threadId: rootSession,
      env,
      output: `${output}.resume.txt`,
      report
    })
    report.resume.firstProvider = firstProvider
    report.resume.builtinOpenaiPrototype = builtinOpenai
    check(
      builtinOpenai
        ? firstProvider === 'openai' && resumed.providerId === 'openai'
        : firstProvider !== resumed.providerId,
      'Native resumed launch reused its old provider namespace'
    )
  }
  const summaries = summarizeNativeProbeRequests(requests)
  report = {
    ...report,
    requests: summaries,
    hookRows,
    rootSession,
    changed,
    transcriptBytes: Buffer.byteLength(raw),
    hookSessionEqualsHttpRoot:
      rootSession !== null && hookRows.some((row) => row.sessionId === rootSession),
    ...nativeProbeScope(process.argv)
  }
  report.rollouts = await collectNativeProbeRollouts(home)
  check(
    execQuota || report.hookSessionEqualsHttpRoot,
    'Native root metadata did not match authentic hook session'
  )
  check(execQuota || changed, 'Authentic canonical Stop did not permit policy boundary')
  verifyNativeProbeRequests({
    requests,
    report,
    raw,
    candidates,
    execQuota,
    toolQuota,
    newConversation,
    vision,
    encryptedModel,
    compactMode,
    approval,
    approvalCapture,
    cancelMode,
    resumeMode
  })
  report.ok = true
  await retireOwner()
} catch (error) {
  report.error =
    gateway?.scrub(String(error instanceof Error ? error.message : error)) ?? String(error)
} finally {
  if (recorder?.exitCode === null) {
    recorder.kill('SIGKILL')
  }
  await retireOwner?.()
  authority?.dispose()
  rateLimits?.stop()
  boundary?.dispose()
  unsub?.()
  detach?.()
  hooks?.stop()
  for (const server of [front, upstream]) {
    if (server) {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    }
  }
  if (engine) {
    report.stopProof = await engine.stop()
  }
  await authTrap?.stop()
  db?.close()
  await rm(root, { recursive: true, force: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}
printNativeProbeResult(report)
if (!report.ok) {
  process.exitCode = 1
}
