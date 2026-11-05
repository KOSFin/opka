import { readClaudeBackgroundTaskLaunch } from '../../shared/claude-owed-task-notifications'
import {
  installClaudeNativeModProbe,
  persistClaudeNativeModProbe
} from './claude-native-mod-probe-fixture'
import { readClaudeBackgroundAgentTasks } from '../../shared/claude-background-task-inventory'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { agentHookServer } from '../agent-hooks/server'
import { buildBody, PANE, postHookEvent } from '../agent-hooks/server.test-fixtures'
import { readPtyAccountPoolChildren } from '../runtime/pty-account-pool-child-inventory'
import { createOwnedClaudeNativePty } from './claude-native-owned-pty-test-fixture'
import { writeClaudeNativeToolProbeResponse } from './claude-native-tool-probe-response'

const enabled = process.platform === 'linux' && process.env.OPKA_SYNTHETIC_LOOPBACK_SCOPE === '1'
it.skipIf(!enabled)(
  'observes actual allowed native background work across the main quota failure in an owned terminal-host PTY',
  async () => {
    const executable = process.env.OPKA_SYNTHETIC_CLAUDE_BINARY
    if (!executable) {
      throw new Error('Explicit qualified native binary required.')
    }
    const modMode = process.env.OPKA_CLAUDE_MOD_PROBE === '1'
    const modEvents: Record<string, unknown>[] = []
    const observedTasks = new Map<string, 'agent' | 'shell'>()
    let mod: Awaited<ReturnType<typeof installClaudeNativeModProbe>> | undefined
    const root = await mkdtemp(join(tmpdir(), 'opka-native-live-children-')),
      config = join(root, 'config'),
      gate = join(root, 'release-background')
    await mkdir(config)
    const events: {
      event: string
      source?: string
      rosterPresent: boolean
      rosterCount: number | null
      child: boolean
      physicalOwner: boolean
      canonicalChildren?: string[]
      mainState?: string
      subagentStates?: string[]
      inventory?: {
        present: boolean
        truncated: boolean
        liveAgentCount: number
        liveOther: boolean
      }
    }[] = []
    let pty: Awaited<ReturnType<typeof createOwnedClaudeNativePty>> | undefined
    let output = '',
      parentRequests = 0,
      messagesRequests = 0,
      childRequest = false,
      childReply: { response: ServerResponse; model: string } | undefined
    let failure = false
    const bodyText = (payload: { messages?: { role?: string; content?: unknown }[] }) => {
      const last = payload.messages?.findLast((message) => message.role === 'user')?.content
      if (typeof last === 'string') {
        return last
      }
      return Array.isArray(last)
        ? last
            .filter((block) => block?.type === 'text')
            .map((block) => block.text ?? '')
            .join('\n')
        : ''
    }
    const server = createServer(async (request, response) => {
      let raw = ''
      for await (const chunk of request) {
        raw += chunk
        if (raw.length > 2 * 1024 * 1024) {
          response.writeHead(413).end()
          return
        }
      }
      const payload = JSON.parse(raw || '{}')
      if (request.url === '/mod-event') {
        if (modEvents.length >= 256) {
          response.writeHead(413).end()
          return
        }
        modEvents.push({
          ...payload,
          knownTaskKind:
            typeof payload.taskId === 'string' ? observedTasks.get(payload.taskId) : undefined
        })
        response.writeHead(200).end('{}')
        return
      }
      if (request.url === '/native-hook') {
        await vi.waitFor(() => expect(pty?.readOwner()).toBeTruthy(), { timeout: 3000 })
        await postHookEvent(agentHookServer, buildBody(payload))
        const row = agentHookServer.getStatusSnapshotForPane(PANE)[0],
          event = payload.hook_event_name
        const launch =
          event === 'PostToolUse'
            ? readClaudeBackgroundTaskLaunch(payload.tool_name, payload.tool_response)
            : null
        if (launch) {
          observedTasks.set(launch.id, launch.kind)
        }
        const inventory = readClaudeBackgroundAgentTasks(payload)
        events.push({
          event,
          source:
            typeof payload.source === 'string' &&
            [
              'startup',
              'resume',
              'clear',
              'compact',
              'fork',
              'user',
              'sdk',
              'system',
              'loop_wakeup',
              'schedule_wakeup',
              'poll_event'
            ].includes(payload.source)
              ? payload.source
              : undefined,
          subagentStates: row?.subagents?.map((child) => child.state),
          inventory: {
            present: inventory.present,
            truncated: inventory.truncated,
            liveAgentCount: inventory.tasks.filter((task) => task.running).length,
            liveOther: inventory.hasRunningNonAgentTask
          },
          rosterPresent: Object.hasOwn(payload, 'background_tasks'),
          rosterCount: Array.isArray(payload.background_tasks)
            ? payload.background_tasks.length
            : null,
          child: typeof payload.agent_id === 'string',
          physicalOwner: !!pty?.readOwner(),
          canonicalChildren: row
            ? readPtyAccountPoolChildren(row)?.map((child) => child.membership)
            : undefined,
          mainState: row?.mainAgent?.state
        })
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify(
            event === 'PreToolUse'
              ? {
                  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
                }
              : {}
          )
        )
        if (event === 'StopFailure') {
          failure = true
          await writeFile(gate, 'release')
          if (childReply) {
            writeClaudeNativeToolProbeResponse(childReply.response, childReply.model, [])
          }
        }
        return
      }
      if (request.url?.startsWith('/v1/messages')) {
        messagesRequests++
        if (bodyText(payload).includes('OPKA_CHILD_REQUEST_MARKER')) {
          childRequest = true
          childReply = { response, model: payload.model }
          if (failure) {
            writeClaudeNativeToolProbeResponse(response, payload.model, [])
          }
          return
        }
        if (
          payload.model !== 'claude-sonnet-4-5' ||
          !JSON.stringify(payload.messages).includes('synthetic-parent-request')
        ) {
          writeClaudeNativeToolProbeResponse(response, payload.model, [])
          return
        }
        if (++parentRequests === 1) {
          writeClaudeNativeToolProbeResponse(response, payload.model, [
            ...(modMode
              ? [
                  {
                    type: 'tool_use' as const,
                    id: 'toolu_synthetic_mcp_echo',
                    name: 'mcp__opka_fixture__echo',
                    input: { value: 'synthetic' }
                  },
                  {
                    type: 'tool_use' as const,
                    id: 'toolu_synthetic_mcp_fail',
                    name: 'mcp__opka_fixture__fail_guard',
                    input: { value: 'synthetic' }
                  }
                ]
              : []),
            {
              type: 'tool_use',
              id: 'toolu_synthetic_background_bash',
              name: 'Bash',
              input: {
                command: `i=0; while [ ! -f '${gate}' ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i+1)); done; printf synthetic-background-finished`,
                run_in_background: true,
                description: 'Synthetic bounded background shell'
              }
            },
            {
              type: 'tool_use',
              id: 'toolu_synthetic_background_agent',
              name: 'Agent',
              input: {
                subagent_type: 'general-purpose',
                description: 'Synthetic background child',
                prompt: 'OPKA_CHILD_REQUEST_MARKER Reply with one fixed synthetic word.',
                run_in_background: true
              }
            }
          ])
        } else if (parentRequests === 2) {
          await vi.waitFor(() => expect(childRequest).toBe(true), { timeout: 5000 })
          response
            .writeHead(429, {
              'content-type': 'application/json',
              'x-should-retry': 'false',
              'retry-after': '1'
            })
            .end(
              '{"type":"error","error":{"type":"rate_limit_error","message":"Synthetic main quota exhausted"}}'
            )
        } else {
          writeClaudeNativeToolProbeResponse(response, payload.model, [])
        }
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
    await agentHookServer.start({ env: 'production', userDataPath: join(root, 'hook-store') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address !== 'object') {
        throw new Error('Missing loopback server.')
      }
      const base = `http://127.0.0.1:${address.port}`,
        script = join(root, 'hook.mjs')
      if (modMode) {
        mod = await installClaudeNativeModProbe(root, base)
      }
      await writeFile(
        script,
        `let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>2097152)throw new Error('Bounded fake hook')};const response=await fetch(${JSON.stringify(`${base}/native-hook`)},{method:'POST',body:input});process.stdout.write(await response.text())`,
        { mode: 0o600 }
      )
      const hooks = Object.fromEntries(
        [
          'SessionStart',
          'UserPromptSubmit',
          'PreToolUse',
          'PostToolUse',
          'PostToolUseFailure',
          'SubagentStart',
          'SubagentStop',
          'Stop',
          'StopFailure'
        ].map((event) => [
          event,
          [{ hooks: [{ type: 'command', command: process.execPath, args: [script], timeout: 8 }] }]
        ])
      )
      await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks }), { mode: 0o600 })
      await writeFile(
        join(config, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-synthetic-background-parent',
            expiresAt: Date.now() + 3600000,
            scopes: ['user:inference', 'user:profile']
          }
        }),
        { mode: 0o600 }
      )
      await writeFile(
        join(config, '.claude.json'),
        JSON.stringify({
          hasCompletedOnboarding: true,
          theme: 'dark',
          oauthAccount: {
            accountUuid: randomUUID(),
            organizationUuid: randomUUID(),
            emailAddress: 'synthetic@example.invalid'
          },
          projects: { [root]: { hasTrustDialogAccepted: true } }
        }),
        { mode: 0o600 }
      )
      pty = await createOwnedClaudeNativePty({
        executable,
        args: [
          '--model',
          'claude-sonnet-4-5',
          '--strict-mcp-config',
          '--setting-sources',
          'user',
          ...(mod ? ['--plugin-dir', mod.plugin, '--mcp-config', mod.mcpConfig] : [])
        ],
        cwd: root,
        paneKey: PANE,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          TERM: 'xterm-256color',
          HOME: root,
          CLAUDE_CONFIG_DIR: config,
          ANTHROPIC_BASE_URL: base,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1'
        },
        onData: (data) => {
          if (output.length < 1024 * 1024) {
            output += data
          }
        }
      })
      await vi.waitFor(
        () => expect(events.some((event) => event.event === 'SessionStart')).toBe(true),
        { timeout: 5000 }
      )
      if (modMode) {
        await vi.waitFor(
          () => expect(modEvents.some((event) => event.event === 'mod-loaded')).toBe(true),
          { timeout: 5000 }
        )
      }
      if (process.env.OPKA_CLAUDE_MOD_TYPES_ONLY === '1') {
        const loaded = mod
        if (!loaded) {
          throw new Error('The metadata-only fixture requires an explicitly loaded mod.')
        }
        await vi.waitFor(
          async () =>
            expect(
              (await persistClaudeNativeModProbe(loaded, undefined)).declarations
            ).toHaveLength(2),
          { timeout: 2000 }
        )
        expect(messagesRequests).toBe(0)
        expect(parentRequests).toBe(0)
        expect(childRequest).toBe(false)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
      pty.write('synthetic-parent-request\r')
      await vi.waitFor(() => expect(failure).toBe(true), { timeout: 15000 })
      await vi.waitFor(
        () => expect(events.some((event) => event.event === 'SubagentStop')).toBe(true),
        { timeout: 5000 }
      )
      const failed = events.find((event) => event.event === 'StopFailure')
      expect(failed?.physicalOwner).toBe(true)
      expect(failed?.subagentStates).toContain('working')
      if (mod) {
        await vi.waitFor(
          () =>
            expect(
              modEvents.some((event) => event.event === 'mod-turn-complete' && event.child === true)
            ).toBe(true),
          { timeout: 5000 }
        )
        await vi.waitFor(
          () =>
            expect(
              modEvents.some(
                (event) =>
                  (event.event === 'mod-prompt-submit' || event.event === 'mod-session-append') &&
                  event.origin === 'task-notification' &&
                  event.knownTaskKind === 'agent' &&
                  typeof event.taskStatus === 'string'
              )
            ).toBe(true),
          { timeout: 5000 }
        )
        await vi.waitFor(
          () =>
            expect(
              modEvents.some(
                (event) =>
                  (event.event === 'mod-prompt-submit' || event.event === 'mod-session-append') &&
                  event.origin === 'task-notification' &&
                  event.knownTaskKind === 'shell' &&
                  typeof event.taskStatus === 'string'
              )
            ).toBe(true),
          { timeout: 5000 }
        )
        expect(
          modEvents.some(
            (event) =>
              event.event === 'mod-tool-done' &&
              event.tool === 'Bash' &&
              event.taskKind === 'shell' &&
              event.knownTaskKind === 'shell'
          )
        ).toBe(true)
        expect(modEvents.some((event) => event.event === 'mod-tool-failed-closed')).toBe(true)
        expect(modEvents.some((event) => event.event === 'mod-tool-catch-after-next')).toBe(true)
        expect(JSON.parse(await readFile(mod.mcpReceipt, 'utf8'))).toEqual({
          tool: 'echo',
          calls: 1
        })
      }
    } finally {
      const receipt = {
        modArtifacts: mod
          ? await persistClaudeNativeModProbe(mod, process.env.OPKA_NATIVE_BACKGROUND_RECEIPT)
          : undefined,
        observedTaskKinds: [...observedTasks.values()],
        modEvents,
        parentRequests,
        messagesRequests,
        childRequest,
        failure,
        events,
        physicalOwner: !!pty?.readOwner(),
        pid: pty?.pid,
        incarnationId: pty?.incarnationId
      }
      if (process.env.OPKA_NATIVE_BACKGROUND_RECEIPT) {
        await writeFile(
          process.env.OPKA_NATIVE_BACKGROUND_RECEIPT,
          JSON.stringify(receipt, null, 2),
          { mode: 0o600 }
        )
      }
      if (process.env.OPKA_NATIVE_BACKGROUND_TRANSCRIPT) {
        await writeFile(process.env.OPKA_NATIVE_BACKGROUND_TRANSCRIPT, output, { mode: 0o600 })
      }
      console.info('Synthetic native owned-PTY background receipt', receipt)
      await writeFile(gate, 'release').catch(() => {})
      if (childReply) {
        writeClaudeNativeToolProbeResponse(childReply.response, childReply.model, [])
      }
      await pty?.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      agentHookServer.stop()
      await rm(root, { recursive: true, force: true })
    }
  },
  30000
)
