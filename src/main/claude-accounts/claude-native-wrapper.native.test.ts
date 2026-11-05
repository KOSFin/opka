import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildClaudeNativeWrapperTestBridge } from './claude-native-wrapper-test-bridge'
import { expect, it, vi } from 'vitest'
import { agentHookServer } from '../agent-hooks/server'
import { PANE } from '../agent-hooks/server.test-fixtures'
import { prepareNativeClaudeRoutingLaunch } from '../runtime/native-claude-routing-launch'
import {
  attachNativeClaudeRoutingOwner,
  releaseNativeClaudeRoutingOwner,
  applyNativeClaudeIdlePolicies
} from '../runtime/native-claude-routing-ownership'
import {
  dispatchNativeClaudeCoverage,
  dispatchNativeClaudeHook
} from '../runtime/native-claude-hook-sessions'
import { NativeClaudeCoverageParams } from '../../shared/native-claude-coverage'
import { nativeCliLaunchArguments } from '../../shared/native-cli-launch-arguments'
import { NativeClaudeHookParams } from '../../shared/native-claude-hook'
import { applyNativeCliAccountEnvironment } from '../../shared/native-cli-account-environment'
import { createOwnedClaudeNativePty } from './claude-native-owned-pty-test-fixture'
import { createNativeClaudeWrapperTestHost } from './claude-native-wrapper-test-host'
import { writeClaudeNativeToolProbeResponse } from './claude-native-tool-probe-response'

const enabled = process.platform === 'linux' && process.env.OPKA_SYNTHETIC_LOOPBACK_SCOPE === '1'
it.skipIf(!enabled)(
  'runs the native account wrapper through real hooks, source projection, physical PTY and saved idle policy',
  async () => {
    const executable = process.env.OPKA_SYNTHETIC_CLAUDE_BINARY
    if (!executable) {
      throw new Error('Explicit native binary required.')
    }
    const root = await mkdtemp(join(tmpdir(), 'opka-native-wrapper-')),
      bridge = join(root, 'hook-bridge.mjs')
    const launchId = randomUUID()
    let pty: Awaited<ReturnType<typeof createOwnedClaudeNativePty>> | undefined,
      host: Awaited<ReturnType<typeof createNativeClaudeWrapperTestHost>> | undefined
    let output = '',
      completed = 0
    const requests: { account: string; metadataAccount: string; prompts: boolean[] }[] = []
    const coverageEvents: {
      kind: string
      sequence: number
      healthy: boolean
      stage?: string
      evidence?: Record<string, boolean | number | undefined>
    }[] = []
    const hookResults: string[] = [],
      errors: string[] = []
    const server = createServer(async (request, response) => {
      let diagnostic = 'parse'
      try {
        let raw = ''
        for await (const chunk of request) {
          raw += chunk
          if (raw.length > 2 * 1024 * 1024) {
            response.writeHead(413).end()
            return
          }
        }
        const payload = JSON.parse(raw || '{}')
        if (request.url === '/coverage' && host) {
          const parsed = NativeClaudeCoverageParams.parse(payload)
          const observation = parsed.observation
          const lead = agentHookServer._getStateForTests().claudeLeadStateByPaneKey.get(PANE)
          const row = agentHookServer.getStatusSnapshotForPane(PANE)[0]
          const evidence =
            observation.kind === 'complete-stop'
              ? {
                  mainPromptMatches:
                    lead?.nativeCoverage?.currentMainPromptId === observation.promptId,
                  canonicalPromptMatches:
                    !!row && agentHookServer.readNativeClaudePromptId(row) === observation.promptId,
                  draft: lead?.nativeCoverage?.draftActive,
                  pendingPrompts: lead?.nativeCoverage?.pendingPrompts.length,
                  requests: lead?.nativeCoverage?.requests.length,
                  hasTurnStart: row?.turnStartedAt !== undefined,
                  completeRoster: row?.claudeNativeBoundaryInventory === 'complete',
                  mainDone: row?.mainAgent?.state === 'done'
                }
              : undefined
          diagnostic = 'coverage-dispatch'
          const result = await dispatchNativeClaudeCoverage(host.runtime, parsed)
          coverageEvents.push({
            kind: parsed.observation.kind,
            sequence: parsed.sequence,
            healthy: result.healthy,
            stage: parsed.observation.kind === 'lost' ? parsed.observation.stage : undefined,
            evidence
          })
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(result))
          if (parsed.observation.kind === 'complete-stop' && result.healthy) {
            completed++
          }
          return
        }
        if (request.url === '/pool-hook' && host) {
          const parsed = NativeClaudeHookParams.parse(payload)
          diagnostic = 'hook-dispatch'
          const result = await dispatchNativeClaudeHook(host.runtime, parsed)
          hookResults.push(`${parsed.event}:${result.action}`)
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(result))
          if (parsed.event === 'stop' && result.action === 'allow') {
            completed++
          }
          return
        }
        if (request.url?.startsWith('/v1/messages')) {
          if (
            payload.model === 'claude-sonnet-4-5' &&
            JSON.stringify(payload.messages).includes('synthetic-wrapper-first')
          ) {
            const auth = request.headers.authorization ?? '',
              metadata = JSON.stringify(payload.metadata?.user_id ?? '')
            const account =
              ['A', 'B', 'C'].find(
                (id) => auth === `Bearer sk-ant-oat01-synthetic-wrapper-${id}`
              ) ?? 'none'
            const metadataAccount =
              host?.identities.find((identity) => metadata.includes(identity.accountUuid))?.id ??
              'none'
            const messages = JSON.stringify(payload.messages)
            requests.push({
              account,
              metadataAccount,
              prompts: ['first', 'second', 'third'].map((label) =>
                messages.includes(`synthetic-wrapper-${label}`)
              )
            })
          }
          writeClaudeNativeToolProbeResponse(response, payload.model, [])
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      } catch {
        errors.push(diagnostic)
        response.writeHead(503).end('{}')
      }
    })
    vi.stubEnv('HOME', root)
    await mkdir(join(root, '.claude'))
    await writeFile(
      join(root, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        theme: 'dark',
        projects: { [root]: { hasTrustDialogAccepted: true } }
      }),
      { mode: 0o600 }
    )
    await writeFile(join(root, '.claude', 'settings.json'), '{}', { mode: 0o600 })
    await agentHookServer.start({ env: 'production', userDataPath: join(root, 'hook-store') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address !== 'object') {
        throw new Error('Missing loopback transport.')
      }
      const base = `http://127.0.0.1:${address.port}`
      await buildClaudeNativeWrapperTestBridge(bridge, base)
      host = await createNativeClaudeWrapperTestHost({
        root,
        executable,
        hookBridge: bridge,
        readPty: () => pty
      })
      const plan = await prepareNativeClaudeRoutingLaunch(
        host.runtime,
        { provider: 'claude', launchId, claudeExecutable: executable },
        true
      )
      if (!plan) {
        throw new Error('Native managed launch missing.')
      }
      const env = applyNativeCliAccountEnvironment(
        {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: root,
          TERM: 'xterm-256color',
          ...agentHookServer.buildPtyEnv(),
          ORCA_PANE_KEY: PANE,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'synthetic-owned-native-folder'
        },
        plan
      )
      const nativeEnv = Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      )
      Object.assign(nativeEnv, {
        ANTHROPIC_BASE_URL: base,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1'
      })
      pty = await createOwnedClaudeNativePty({
        executable,
        args: nativeCliLaunchArguments(
          'claude',
          ['--model', 'claude-sonnet-4-5', '--strict-mcp-config'],
          plan
        ),
        cwd: root,
        env: nativeEnv,
        paneKey: PANE,
        launchId,
        bindingRuntime: host.runtime,
        onData: (data) => {
          if (output.length < 1024 * 1024) {
            output += data
          }
        }
      })
      attachNativeClaudeRoutingOwner(host.runtime, launchId)
      await vi.waitFor(
        () => expect(agentHookServer.getStatusSnapshotForPane(PANE)[0]?.sessionBoundary).toBe(true),
        { timeout: 5000 }
      )
      await new Promise((resolve) => setTimeout(resolve, 1000))
      pty.write('synthetic-wrapper-first\r')
      await vi.waitFor(() => expect(completed).toBe(1), { timeout: 12000 })
      pty.write('synthetic-wrapper-second\r')
      await vi.waitFor(() => expect(completed).toBe(2), { timeout: 12000 })
      expect(
        requests.slice(0, 2).map((request) => [request.account, request.metadataAccount])
      ).toEqual([
        ['A', 'A'],
        ['B', 'B']
      ])
      const facade = plan.env.CLAUDE_CONFIG_DIR
      expect(
        JSON.parse(await readFile(join(facade, '.claude.json'), 'utf8')).oauthAccount.accountUuid
      ).toBe(host.identities[2].accountUuid)
      host.policy.revision++
      host.policy.members.forEach((member) => {
        member.priority = member.accountId === 'A' ? 1 : 2
      })
      await applyNativeClaudeIdlePolicies(host.runtime)
      expect(
        JSON.parse(await readFile(join(facade, '.claude.json'), 'utf8')).oauthAccount.accountUuid
      ).toBe(host.identities[0].accountUuid)
      pty.write('synthetic-wrapper-third\r')
      await vi.waitFor(() => expect(completed).toBe(3), { timeout: 12000 })
      expect(requests.at(-1)).toEqual({
        account: 'A',
        metadataAccount: 'A',
        prompts: [true, true, true]
      })
      expect(
        (await readFile(join(facade, '.credentials.json'), 'utf8')).includes('refreshToken')
      ).toBe(false)
      expect(await host.sourceTokensRemainPrivate()).toBe(true)
      expect(errors).toEqual([])
    } finally {
      const receipt = {
        requests,
        coverageEvents,
        completed,
        hookResults,
        errors,
        physicalOwner: !!pty?.readOwner(),
        pid: pty?.pid,
        incarnationId: pty?.incarnationId,
        sourceRefreshProcess: 'explicit synthetic seam; native authority independently qualified'
      }
      if (process.env.OPKA_NATIVE_WRAPPER_RECEIPT) {
        await writeFile(process.env.OPKA_NATIVE_WRAPPER_RECEIPT, JSON.stringify(receipt, null, 2), {
          mode: 0o600
        })
      }
      if (process.env.OPKA_NATIVE_WRAPPER_TRANSCRIPT) {
        await writeFile(process.env.OPKA_NATIVE_WRAPPER_TRANSCRIPT, output, { mode: 0o600 })
      }
      console.info('Synthetic native wrapper receipt', receipt)
      if (host) {
        await releaseNativeClaudeRoutingOwner(host.runtime, launchId)
      }
      await pty?.dispose()
      await host?.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      agentHookServer.stop()
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  },
  45000
)
