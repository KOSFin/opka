import { readFileSync } from 'node:fs'
import * as coverageInstall from './claude-native-coverage-install'
import {
  installSynchronousNativeRewakePrototype,
  readNativePrintResultSummary
} from './claude-native-stdio-rewake-prototype'
import { runProcess } from '@orca/process-host'
import * as usageRequest from '../rate-limits/claude-oauth-usage-request'
import * as nativeEnvironment from '../../shared/native-cli-account-environment'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { agentHookServer } from '../agent-hooks/server'
import { NativeClaudeCoverageParams } from '../../shared/native-claude-coverage'
import { NativeClaudeHookParams } from '../../shared/native-claude-hook'
import {
  dispatchNativeClaudeCoverage,
  dispatchNativeClaudeHook
} from '../runtime/native-claude-hook-sessions'
import { getRuntimeClaudeNativeSources } from '../runtime/runtime-claude-native-sources'
import {
  startNativeCliStdio,
  requireNativeCliStdioSession,
  stopNativeCliStdioSessions
} from '../runtime/native-cli-stdio-host'
import {
  readNativeCliStdioOwner,
  readNativeCliStdioObservationOwner
} from '../runtime/native-cli-stdio-owner'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createNativeClaudeWrapperTestHost } from './claude-native-wrapper-test-host'
import { buildClaudeNativeWrapperTestBridge } from './claude-native-wrapper-test-bridge'
import { writeClaudeNativeToolProbeResponse } from './claude-native-tool-probe-response'

const onLimit = process.env.OPKA_NATIVE_STDIO_ON_LIMIT === '1'
const synchronousRewake = process.env.OPKA_NATIVE_STDIO_SYNC_REWAKE === '1'
const outputFormat = process.env.OPKA_NATIVE_STDIO_OUTPUT_FORMAT === 'json' ? 'json' : 'stream-json'
const enabled = process.platform === 'linux' && process.env.OPKA_SYNTHETIC_LOOPBACK_SCOPE === '1'
it.skipIf(!enabled)(
  onLimit
    ? 'continues an accepted native print task after a real quota failure on a coherent account'
    : 'runs unmodified print mode through genuine raw stdio ownership and renews access before native requests',
  async () => {
    const executable = process.env.OPKA_SYNTHETIC_CLAUDE_BINARY
    if (!executable) {
      throw new Error('Explicit qualified native executable required.')
    }
    const root = await mkdtemp(join(tmpdir(), 'opka-native-stdio-wrapper-'))
    const launchId = randomUUID(),
      bridge = join(root, 'hook-bridge.mjs')
    let deadline: ReturnType<typeof setTimeout> | undefined
    let deadlineStopped = false
    let restoreInstall: (() => void) | undefined
    const prototype: Record<string, unknown>[] = []
    const installedSources: Record<string, string | boolean>[] = []
    let restoreUsage: (() => void) | undefined
    let quotaFetches = 0
    const hooks: { event: string; action: string }[] = []
    const observations: Record<string, string | boolean | number | undefined>[] = []
    const startedAt = Date.now()
    let restoreEnvironment: (() => void) | undefined
    let host: Awaited<ReturnType<typeof createNativeClaudeWrapperTestHost>> | undefined
    let stdout = '',
      stderr = '',
      exitCode: number | undefined,
      refreshes = 0
    const requests: {
      account: 'A' | 'B' | 'unknown'
      credential: 'fresh' | 'stale' | 'unknown'
      identity: boolean
      original: boolean
      toolResult: boolean
      staleWake: boolean
      blockedWakeInHistory: boolean
      originalCount: number
    }[] = []
    const errors: string[] = []
    const server = createServer(async (request, response) => {
      try {
        let raw = ''
        for await (const chunk of request) {
          raw += chunk
          if (raw.length > 2 * 1024 * 1024) {
            response.writeHead(413).end()
            return
          }
        }
        const body = JSON.parse(raw || '{}')
        if (request.url === '/prototype-wake') {
          if (prototype.length >= 16) {
            throw new Error('Fixture prototype count exceeded.')
          }
          prototype.push({
            action: body.action,
            code: body.code,
            step: body.step,
            queued: body.queued,
            markers: body.markers,
            lead: body.lead,
            errorRate: body.errorRate,
            hasPrompt: body.hasPrompt,
            hasSession: body.hasSession
          })
          response.writeHead(200).end('{}')
          return
        }
        if (request.url === '/coverage' && host) {
          const parsed = NativeClaudeCoverageParams.parse(body)
          const result = await dispatchNativeClaudeCoverage(host.runtime, parsed)
          const owner = readNativeCliStdioObservationOwner(host.runtime, launchId)
          const lead = owner
            ? agentHookServer.readNativeClaudeStructuredLead(owner.subject)?.lead
            : undefined
          const state = lead?.nativeCoverage
          if (observations.length >= 256) {
            throw new Error('Fixture observation count exceeded.')
          }
          observations.push({
            kind: parsed.observation.kind,
            healthy: result.healthy,
            origin:
              parsed.observation.kind === 'canonical-hook'
                ? parsed.observation.hook.nativeOrigin
                : undefined,
            event:
              parsed.observation.kind === 'canonical-hook'
                ? parsed.observation.hook.event
                : undefined,
            promptPresent:
              parsed.observation.kind === 'canonical-hook'
                ? !!parsed.observation.hook.promptId
                : undefined,
            failure: !!lead?.nativeFailure,
            mainError: state?.mainTurn?.reason === 'error',
            tools: state?.tools.length,
            requests: state?.requests.length,
            children: state?.pendingTasks.length,
            agents: state?.liveAgents.length,
            prompts: state?.pendingPrompts.length,
            draft: state?.draftActive,
            draftUnknown: state?.draftUnverifiable === true,
            strictOwner: !!readNativeCliStdioOwner(host.runtime, launchId),
            failureBoundary: owner
              ? agentHookServer
                  .readNativeClaudeFailureBoundary({
                    kind: 'stdio',
                    owner,
                    launchId,
                    sessionId: parsed.sessionId,
                    startedAt
                  })
                  .canSwitch()
              : false
          })
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(result))
          return
        }
        if (request.url === '/pool-hook' && host) {
          const parsed = NativeClaudeHookParams.parse(body)
          if (hooks.length >= 128) {
            throw new Error('Fixture hook count exceeded.')
          }
          hooks.push({ event: parsed.event, action: 'received' })
          const result = await dispatchNativeClaudeHook(host.runtime, parsed)
          hooks.push({ event: parsed.event, action: result.action })
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(result))
          return
        }
        if (request.url?.startsWith('/v1/messages') && host) {
          const messages = JSON.stringify(body.messages)
          const lastUser = Array.isArray(body.messages)
            ? body.messages.findLast((message: { role?: string }) => message.role === 'user')
            : undefined
          if (body.model === 'claude-sonnet-4-5') {
            const authorization = request.headers.authorization
            const account =
              authorization === 'Bearer sk-ant-oat01-synthetic-renewed-A'
                ? 'A'
                : authorization === 'Bearer sk-ant-oat01-synthetic-wrapper-B'
                  ? 'B'
                  : 'unknown'
            if (requests.length >= 16) {
              throw new Error('Fixture model count exceeded.')
            }
            requests.push({
              account,
              credential:
                account === 'A' || account === 'B'
                  ? 'fresh'
                  : authorization === 'Bearer sk-ant-oat01-synthetic-wrapper-A'
                    ? 'stale'
                    : 'unknown',
              identity: JSON.stringify(body.metadata?.user_id ?? '').includes(
                host.identities.find((entry) => entry.id === account)?.accountUuid ??
                  'no-matching-identity'
              ),
              original: messages.includes('synthetic-stdio-expiry'),
              toolResult: messages.includes('synthetic-stdio-tool-result'),
              staleWake: /<opka-native-wake:v1:[a-f0-9-]{36}:1:[a-f0-9]{64}>/.test(
                JSON.stringify(lastUser?.content ?? '')
              ),
              blockedWakeInHistory: /<opka-native-wake:v1:[a-f0-9-]{36}:1:[a-f0-9]{64}>/.test(
                messages
              ),
              originalCount: (messages.match(/synthetic-stdio-expiry/g) ?? []).length
            })
            if (onLimit && account === 'A' && requests.length > 1) {
              response
                .writeHead(429, {
                  'content-type': 'application/json',
                  'x-should-retry': 'false',
                  'retry-after': '1'
                })
                .end(
                  '{"type":"error","error":{"type":"rate_limit_error","message":"Synthetic native print quota exhausted"}}'
                )
              return
            }
            writeClaudeNativeToolProbeResponse(
              response,
              body.model,
              requests.length === 1
                ? [
                    {
                      type: 'tool_use',
                      id: 'toolu_actual_stdio_bash',
                      name: 'Bash',
                      input: {
                        command: 'printf synthetic-stdio-tool-result',
                        description: 'Fixed isolated fixture'
                      }
                    }
                  ]
                : []
            )
            return
          }
          writeClaudeNativeToolProbeResponse(response, body.model, [])
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      } catch {
        errors.push('private-host-or-fixture-refused')
        response.writeHead(503).end('{}')
      }
    })
    vi.stubEnv('HOME', root)
    await mkdir(join(root, '.claude'))
    await writeFile(
      join(root, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        projects: { [root]: { hasTrustDialogAccepted: true } }
      }),
      { mode: 0o600 }
    )
    await writeFile(join(root, '.claude', 'settings.json'), '{}', { mode: 0o600 })
    await agentHookServer.start({ env: 'production', userDataPath: join(root, 'hooks') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address !== 'object') {
        throw new Error('Loopback endpoint unavailable.')
      }
      const base = `http://127.0.0.1:${address.port}`
      const applyEnvironment = nativeEnvironment.applyNativeCliAccountEnvironment
      const environment = vi
        .spyOn(nativeEnvironment, 'applyNativeCliAccountEnvironment')
        .mockImplementation((env, plan) => ({
          ...applyEnvironment(env, plan),
          ANTHROPIC_BASE_URL: base
        }))
      restoreEnvironment = () => environment.mockRestore()
      if (onLimit) {
        const usage = vi
          .spyOn(usageRequest, 'fetchClaudeOAuthUsage')
          .mockImplementation(async () => {
            quotaFetches++
            return {
              provider: 'claude',
              session: {
                usedPercent: 100,
                windowMinutes: 300,
                resetsAt: Date.now() + 60_000,
                resetDescription: null
              },
              weekly: null,
              updatedAt: Date.now(),
              status: 'ok',
              error: null
            }
          })
        restoreUsage = () => usage.mockRestore()
      }
      await buildClaudeNativeWrapperTestBridge(bridge, base)
      if (synchronousRewake) {
        const bridgeSource = readFileSync(bridge, 'utf8')
        const entry = 'process.exitCode = await'
        if (!bridgeSource.includes(entry)) {
          throw new Error('Prototype bridge entry mismatch.')
        }
        const diagnostic = `if(process.argv[3]==='native-pool-hook'&&process.argv[5]==='failure')await fetch(${JSON.stringify(`${base}/prototype-wake`)},{method:'POST',body:JSON.stringify({action:'helper-started'})});\n`
        await writeFile(bridge, bridgeSource.replace(entry, diagnostic + entry), { mode: 0o600 })
        const install = coverageInstall.installClaudeNativeCoverageModule
        const installer = vi
          .spyOn(coverageInstall, 'installClaudeNativeCoverageModule')
          .mockImplementation((options) => {
            const directory = install(options)
            const source = installSynchronousNativeRewakePrototype(
              directory,
              options.launchId,
              options.launch,
              base
            )
            const manifest: unknown = JSON.parse(
              readFileSync(join(directory, '.claude-plugin', 'plugin.json'), 'utf8')
            )
            const hookManifest: unknown = JSON.parse(
              readFileSync(join(directory, 'hooks', 'hooks.json'), 'utf8')
            )
            const validManifest =
              !!manifest &&
              typeof manifest === 'object' &&
              'name' in manifest &&
              manifest.name === 'opka-native-continuity'
            const validEntry =
              !!hookManifest &&
              typeof hookManifest === 'object' &&
              'modules' in hookManifest &&
              Array.isArray(hookManifest.modules) &&
              hookManifest.modules.includes('./register.js')
            installedSources.push({
              ...source,
              mode: options.home === join(root, 'prototype-validation') ? 'validation' : 'facade',
              validManifest,
              validEntry
            })
            if (!validManifest || !validEntry || !source.failurePatched || !source.promptPatched) {
              throw new Error('Prototype manifest entry mismatch.')
            }
            return directory
          })
        restoreInstall = () => installer.mockRestore()
        const home = join(root, 'prototype-validation')
        await mkdir(home)
        const directory = coverageInstall.installClaudeNativeCoverageModule({
          home,
          launchId,
          launch: { command: process.execPath, args: [bridge] },
          assertExclusive: () => {}
        })
        const validated = await runProcess({
          program: executable,
          args: ['plugin', 'validate', directory],
          cwd: root,
          env: {
            HOME: root,
            CLAUDE_CONFIG_DIR: home,
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            DISABLE_AUTOUPDATER: '1',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
          },
          timeoutMs: 10_000,
          maxOutputBytes: 128 * 1024
        })
        expect(validated.code, validated.stdout + validated.stderr).toBe(0)
      }
      host = await createNativeClaudeWrapperTestHost({
        root,
        executable,
        hookBridge: bridge,
        readPty: () => undefined,
        rotation: 'on-limit'
      })
      const store = await openTestAgentSessionRecordStore(join(root, 'journal'))
      Object.assign(host.runtime, {
        openAgentSessionRecordStore: async () => store,
        getNativeCliAgentSessionClaimKeyId: () => 'isolated-stdio-native-claim',
        getRuntimeId: () => 'isolated-native-stdio-host',
        openedOrchestrationDb: () => host?.db ?? null
      })
      const sources = getRuntimeClaudeNativeSources(host.runtime)
      if (!sources) {
        throw new Error('Synthetic native source missing.')
      }
      const originalRefresh = vi.mocked(sources.refresh).getMockImplementation()
      if (!originalRefresh) {
        throw new Error('Synthetic refresh seam missing.')
      }
      vi.mocked(sources.refresh).mockImplementation(async (id, signal) => {
        const access = await originalRefresh(id, signal)
        refreshes++
        return {
          ...access,
          access: {
            ...access.access,
            expiresAt: Date.now() + (refreshes === 1 ? 45_000 : 3_600_000),
            accessToken:
              refreshes === 1 || id !== 'A'
                ? access.access.accessToken
                : 'sk-ant-oat01-synthetic-renewed-A'
          }
        }
      })
      const result = await startNativeCliStdio(host.runtime, {
        launchId,
        executable,
        cwd: root,
        args: [
          '-p',
          'synthetic-stdio-expiry',
          '--model',
          'claude-sonnet-4-5',
          '--output-format',
          outputFormat,
          '--verbose',
          '--strict-mcp-config',
          '--no-session-persistence',
          '--dangerously-skip-permissions'
        ],
        env: {
          HOME: root,
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          ANTHROPIC_BASE_URL: base,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1'
        }
      })
      if (synchronousRewake) {
        expect(
          installedSources.some(
            (entry) => entry.mode === 'facade' && entry.failurePatched && entry.promptPatched
          )
        ).toBe(true)
      }
      const session = requireNativeCliStdioSession(host.runtime, result.launchId, result.generation)
      const owner = readNativeCliStdioOwner(host.runtime, launchId)
      expect(owner?.process.pid).toBe(session.group?.pgid)
      expect(owner?.process.processStartTimeMs).toBeGreaterThan(0)
      session.attached = true
      const detach = session.output.attach((frame) => {
        if (frame.type === 'native-stdio-exit') {
          exitCode = frame.code
          return
        }
        const bytes = Buffer.from(frame.bytes, 'base64').toString()
        if (stdout.length + stderr.length > 512 * 1024) {
          throw new Error('Fixture output exceeds bound.')
        }
        if (frame.channel === 'stdout') {
          stdout += bytes
        } else {
          stderr += bytes
        }
        session.output.acknowledge(frame.sequence)
      })
      await session.control({ ...result, sequence: 0, inputSequence: 1, eof: true })
      if (synchronousRewake) {
        deadline = setTimeout(() => {
          deadlineStopped = true
          void session.close()
        }, 25_000)
      }
      await session.done
      clearTimeout(deadline)
      detach()
      const summary = readNativePrintResultSummary(stdout, outputFormat)
      expect(summary.valid).toBe(true)
      expect(summary.lastError).toBe(false)
      expect(exitCode).toBe(0)
      if (onLimit) {
        expect(requests.some((entry) => entry.account === 'B')).toBe(true)
      } else {
        expect(requests).toHaveLength(2)
      }
      expect(
        requests.every((entry) => entry.credential === 'fresh' && entry.identity && entry.original)
      ).toBe(true)
      expect(requests[1].toolResult).toBe(true)
      expect(requests.every((entry) => !entry.staleWake && entry.originalCount === 1)).toBe(true)
      expect(refreshes).toBeGreaterThanOrEqual(2)
      expect(errors).toEqual([])
      expect(store.listRecords()).toHaveLength(0)
      if (owner) {
        expect(agentHookServer.readNativeClaudeStructuredLead(owner.subject)).toBeNull()
      }
    } finally {
      const output = readNativePrintResultSummary(stdout, outputFormat)
      const receipt = {
        output,
        mode: onLimit ? 'on-limit' : 'expiry',
        synchronousRewake,
        deadlineStopped,
        outputFormat,
        prototype,
        prototypeEntries: {
          loaded: stdout.includes('opka-prototype-loaded'),
          failure: stdout.includes('opka-prototype-failure-entry'),
          acknowledged: stdout.includes('opka-prototype-failure-acked')
        },
        installedSources,
        requests,
        refreshes,
        quotaFetches,
        hooks,
        observations,
        exitCode,
        errors,
        sourceRefreshProcess:
          'explicit synthetic source seam; native authority separately qualified',
        fakeEndpoint: 'injected after production auth-environment isolation'
      }
      if (process.env.OPKA_NATIVE_STDIO_RECEIPT) {
        await writeFile(process.env.OPKA_NATIVE_STDIO_RECEIPT, JSON.stringify(receipt, null, 2), {
          mode: 0o600
        })
      }
      if (process.env.OPKA_NATIVE_STDIO_OUTPUT) {
        await writeFile(process.env.OPKA_NATIVE_STDIO_OUTPUT, `${stdout}\nSTDERR\n${stderr}`, {
          mode: 0o600
        })
      }
      if (host) {
        await stopNativeCliStdioSessions(host.runtime)
        await host.dispose()
      }
      clearTimeout(deadline)
      restoreInstall?.()
      restoreEnvironment?.()
      restoreUsage?.()
      closeTestJournalHostDatabases()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      agentHookServer.stop()
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  },
  45000
)
