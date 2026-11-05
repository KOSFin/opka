import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { agentHookServer } from '../agent-hooks/server'
import { PANE } from '../agent-hooks/server.test-fixtures'
import { prepareNativeClaudeRoutingLaunch } from '../runtime/native-claude-routing-launch'
import {
  attachNativeClaudeRoutingOwner,
  releaseNativeClaudeRoutingOwner
} from '../runtime/native-claude-routing-ownership'
import {
  dispatchNativeClaudeCoverage,
  dispatchNativeClaudeHook
} from '../runtime/native-claude-hook-sessions'
import { NativeClaudeCoverageParams } from '../../shared/native-claude-coverage'
import { NativeClaudeHookParams } from '../../shared/native-claude-hook'
import { nativeCliLaunchArguments } from '../../shared/native-cli-launch-arguments'
import { applyNativeCliAccountEnvironment } from '../../shared/native-cli-account-environment'
import { createOwnedClaudeNativePty } from './claude-native-owned-pty-test-fixture'
import { createNativeClaudeWrapperTestHost } from './claude-native-wrapper-test-host'
import { buildClaudeNativeWrapperTestBridge } from './claude-native-wrapper-test-bridge'
import { writeClaudeNativeToolProbeResponse } from './claude-native-tool-probe-response'

const enabled = process.platform === 'linux' && process.env.OPKA_SYNTHETIC_LOOPBACK_SCOPE === '1'
it.skipIf(!enabled)(
  'continues the accepted native task on a coherent account after actual Bash and Agent work settles',
  async () => {
    const executable = process.env.OPKA_SYNTHETIC_CLAUDE_BINARY
    if (!executable) {
      throw new Error('Explicit native binary required.')
    }
    const root = await mkdtemp(join(tmpdir(), 'opka-native-wrapper-limit-')),
      bridge = join(root, 'hook-bridge.mjs'),
      gate = join(root, 'release-background'),
      launchId = randomUUID()
    let pty: Awaited<ReturnType<typeof createOwnedClaudeNativePty>> | undefined,
      host: Awaited<ReturnType<typeof createNativeClaudeWrapperTestHost>> | undefined,
      child: { response: ServerResponse; model: string } | undefined
    let output = '',
      failures = 0,
      parentA = 0,
      completed = 0
    const coverage: { kind: string; healthy: boolean; stage?: string }[] = [],
      errors: string[] = []
    const requests: {
      account: string
      metadataAccount: string
      child: boolean
      originalTask: boolean
    }[] = []
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
        const payload = JSON.parse(raw || '{}')
        if (request.url === '/coverage' && host) {
          const parsed = NativeClaudeCoverageParams.parse(payload),
            result = await dispatchNativeClaudeCoverage(host.runtime, parsed)
          coverage.push({
            kind: parsed.observation.kind,
            healthy: result.healthy,
            stage: parsed.observation.kind === 'lost' ? parsed.observation.stage : undefined
          })
          if (parsed.observation.kind === 'complete-stop') {
            completed++
          }
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(result))
          return
        }
        if (request.url === '/pool-hook' && host) {
          const parsed = NativeClaudeHookParams.parse(payload)
          if (parsed.event === 'failure') {
            failures++
            await writeFile(gate, 'release')
            if (child) {
              writeClaudeNativeToolProbeResponse(child.response, child.model, [])
            }
          }
          const result = await dispatchNativeClaudeHook(host.runtime, parsed)
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(result))
          return
        }
        if (request.url?.startsWith('/v1/messages') && host) {
          const text = JSON.stringify(payload.messages),
            auth = request.headers.authorization ?? '',
            metadata = JSON.stringify(payload.metadata?.user_id ?? '')
          const account =
            ['A', 'B', 'C'].find((id) => auth === `Bearer sk-ant-oat01-synthetic-wrapper-${id}`) ??
            'none'
          const metadataAccount =
            host.identities.find((identity) => metadata.includes(identity.accountUuid))?.id ??
            'none'
          const lastUser = payload.messages?.findLast(
            (message: { role?: string }) => message.role === 'user'
          )?.content
          const isChild = JSON.stringify(lastUser).includes('OPKA_LIMIT_CHILD_REQUEST')
          if (payload.model !== 'claude-sonnet-4-5') {
            writeClaudeNativeToolProbeResponse(response, payload.model, [])
            return
          }
          requests.push({
            account,
            metadataAccount,
            child: isChild,
            originalTask: text.includes('synthetic-owned-limit-original')
          })
          if (isChild) {
            child = { response, model: payload.model }
            if (failures) {
              writeClaudeNativeToolProbeResponse(response, payload.model, [])
            }
            return
          }
          if (account === 'A' && ++parentA === 1) {
            writeClaudeNativeToolProbeResponse(response, payload.model, [
              {
                type: 'tool_use',
                id: 'toolu_owned_limit_bash',
                name: 'Bash',
                input: {
                  command: `i=0; while [ ! -f '${gate}' ] && [ "$i" -lt 120 ]; do sleep 0.1; i=$((i+1)); done; printf synthetic-background-finished`,
                  run_in_background: true,
                  description: 'Bounded synthetic shell'
                }
              },
              {
                type: 'tool_use',
                id: 'toolu_owned_limit_agent',
                name: 'Agent',
                input: {
                  subagent_type: 'general-purpose',
                  description: 'Bounded synthetic child',
                  prompt: 'OPKA_LIMIT_CHILD_REQUEST Reply with a fixed synthetic word.',
                  run_in_background: true
                }
              }
            ])
            return
          }
          if (account === 'A') {
            await vi.waitFor(() => expect(child).toBeDefined(), { timeout: 5000 })
            response
              .writeHead(429, {
                'content-type': 'application/json',
                'x-should-retry': 'false',
                'retry-after': '1'
              })
              .end(
                '{"type":"error","error":{"type":"rate_limit_error","message":"Synthetic main quota exhausted"}}'
              )
            return
          }
          writeClaudeNativeToolProbeResponse(response, payload.model, [])
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      } catch {
        errors.push('private-hook-or-transport-refused')
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
        readPty: () => pty,
        rotation: 'on-limit'
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
          ['--model', 'claude-sonnet-4-5', '--strict-mcp-config', '--dangerously-skip-permissions'],
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
        () => {
          expect(output).toContain('WARNING:')
          expect(output).toContain('responsibility')
          expect(output).toContain('accept')
        },
        { timeout: 5000 }
      )
      // Captured native first-run setup consent, before any task is submitted.
      pty.write('\x1b[B\r')
      await vi.waitFor(
        () => expect(agentHookServer.getStatusSnapshotForPane(PANE)[0]?.sessionBoundary).toBe(true),
        { timeout: 5000 }
      )
      await new Promise((resolve) => setTimeout(resolve, 1000))
      pty.write('synthetic-owned-limit-original\r')
      await vi.waitFor(
        () =>
          expect(requests.some((request) => request.account === 'B' && !request.child)).toBe(true),
        { timeout: 30000 }
      )
      expect(failures).toBeGreaterThan(0)
      expect(child).toBeDefined()
      expect(requests.every((request) => request.account === request.metadataAccount)).toBe(true)
      expect(
        requests
          .filter((request) => request.account === 'B' && !request.child)
          .every((request) => request.originalTask)
      ).toBe(true)
      expect(errors).toEqual([])
    } finally {
      const receipt = {
        requests,
        coverage,
        failures,
        completed,
        errors,
        physicalOwner: !!pty?.readOwner(),
        sourceRefreshProcess: 'explicit synthetic seam; native authority independently qualified'
      }
      if (process.env.OPKA_NATIVE_WRAPPER_LIMIT_RECEIPT) {
        await writeFile(
          process.env.OPKA_NATIVE_WRAPPER_LIMIT_RECEIPT,
          JSON.stringify(receipt, null, 2),
          { mode: 0o600 }
        )
      }
      if (process.env.OPKA_NATIVE_WRAPPER_LIMIT_TRANSCRIPT) {
        await writeFile(process.env.OPKA_NATIVE_WRAPPER_LIMIT_TRANSCRIPT, output, { mode: 0o600 })
      }
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
