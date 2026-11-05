import { writeClaudeNativeToolProbeResponse } from './claude-native-tool-probe-response'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { agentHookServer } from '../agent-hooks/server'
import { buildBody, PANE, postHookEvent } from '../agent-hooks/server.test-fixtures'

const enabled = process.platform === 'linux' && process.env.OPKA_SYNTHETIC_LOOPBACK_SCOPE === '1'

type HookShape = {
  event: string
  backgroundTasksPresent: boolean
  backgroundTasksCount: number | null
  childIdentityPresent: boolean
  canonicalToolIntent?: boolean
  freshStartup?: boolean
  acknowledgementDelivered?: boolean
}

it.skipIf(!enabled)(
  'denies native background Bash and Agent only after their real hook intents reach the canonical store',
  async () => {
    const cli = process.env.OPKA_SYNTHETIC_CLAUDE_BINARY
    if (!cli) {
      throw new Error('An explicitly qualified synthetic native binary is required.')
    }
    const root = await mkdtemp(join(tmpdir(), 'opka-native-tool-guard-')),
      config = join(root, 'config'),
      marker = join(root, 'unexpected-tool-execution'),
      script = join(root, 'private-hook.mjs')
    await mkdir(config)
    const events: HookShape[] = []
    let mainRequests = 0,
      denialResults = 0
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) {
        body += chunk
        if (body.length > 2 * 1024 * 1024) {
          response.writeHead(413).end()
          return
        }
      }
      const payload = JSON.parse(body || '{}')
      if (request.url === '/native-hook') {
        const event = payload.hook_event_name
        await postHookEvent(agentHookServer, buildBody(payload))
        const row = agentHookServer.getStatusSnapshotForPane(PANE)[0]
        events.push({
          event,
          ...(event === 'SessionStart' ? { freshStartup: payload.source === 'startup' } : {}),
          backgroundTasksPresent: Object.hasOwn(payload, 'background_tasks'),
          backgroundTasksCount: Array.isArray(payload.background_tasks)
            ? payload.background_tasks.length
            : null,
          childIdentityPresent: typeof payload.agent_id === 'string',
          ...(event === 'PreToolUse'
            ? {
                canonicalToolIntent: row?.toolName === payload.tool_name,
                acknowledgementDelivered: payload.tool_name !== 'Agent'
              }
            : {})
        })
        if (event === 'PreToolUse' && payload.tool_name === 'Agent') {
          response.writeHead(503).end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify(
            event === 'PreToolUse'
              ? {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: 'Synthetic owning-host tool admission refused.'
                  }
                }
              : {}
          )
        )
        return
      }
      if (request.url?.startsWith('/v1/messages')) {
        if (!JSON.stringify(payload.messages).includes('synthetic-tool-guard-request')) {
          writeClaudeNativeToolProbeResponse(response, payload.model, [])
          return
        }
        mainRequests++
        denialResults = (
          JSON.stringify(payload.messages).match(
            /Synthetic owning-host tool admission refused\./g
          ) ?? []
        ).length
        writeClaudeNativeToolProbeResponse(
          response,
          payload.model,
          mainRequests === 1
            ? [
                {
                  type: 'tool_use',
                  id: 'toolu_synthetic_bash',
                  name: 'Bash',
                  input: {
                    command: `printf synthetic > '${marker}'`,
                    run_in_background: true,
                    description: 'Synthetic background marker'
                  }
                },
                {
                  type: 'tool_use',
                  id: 'toolu_synthetic_agent',
                  name: 'Agent',
                  input: {
                    subagent_type: 'general-purpose',
                    description: 'Synthetic denied child',
                    prompt: 'Fixed synthetic child task',
                    run_in_background: true
                  }
                }
              ]
            : []
        )
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
    await agentHookServer.start({ env: 'production', userDataPath: join(root, 'hook-store') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address !== 'object') {
        throw new Error('Missing synthetic loopback server')
      }
      const baseUrl = `http://127.0.0.1:${address.port}`
      await writeFile(
        script,
        `
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>2097152)throw new Error('Synthetic hook bound')}
const native=JSON.parse(input)
try {
  const result=await fetch(${JSON.stringify(`${baseUrl}/native-hook`)},{method:'POST',body:input})
  if(!result.ok)throw new Error('Synthetic host unavailable')
  process.stdout.write(await result.text())
} catch {
  process.stdout.write(JSON.stringify(native.hook_event_name==='PreToolUse'?{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Synthetic owning-host tool admission refused.'}}:{}))
}
`,
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
        ].map((name) => [
          name,
          [{ hooks: [{ type: 'command', command: process.execPath, args: [script], timeout: 8 }] }]
        ])
      )
      await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks }), { mode: 0o600 })
      await writeFile(
        join(config, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-synthetic-tool-guard',
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
          oauthAccount: {
            accountUuid: randomUUID(),
            organizationUuid: randomUUID(),
            emailAddress: 'synthetic@example.invalid'
          }
        }),
        { mode: 0o600 }
      )
      const result = await runProcess({
        program: cli,
        args: [
          '-p',
          'synthetic-tool-guard-request',
          '--model',
          'claude-sonnet-4-5',
          '--dangerously-skip-permissions',
          '--no-session-persistence',
          '--strict-mcp-config',
          '--setting-sources',
          'user'
        ],
        cwd: root,
        env: {
          HOME: root,
          CLAUDE_CONFIG_DIR: config,
          ANTHROPIC_BASE_URL: baseUrl,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1'
        },
        input: '',
        timeoutMs: 25000
      })
      const markerAbsent = await access(marker).then(
        () => false,
        () => true
      )
      const receipt = { code: result.code, mainRequests, denialResults, markerAbsent, events }
      console.info('Synthetic native public tool guard receipt', receipt)
      if (process.env.OPKA_NATIVE_TOOL_GUARD_RECEIPT) {
        await writeFile(
          process.env.OPKA_NATIVE_TOOL_GUARD_RECEIPT,
          JSON.stringify(receipt, null, 2),
          { mode: 0o600 }
        )
      }
      expect(result.code).toBe(0)
      expect(mainRequests).toBeGreaterThanOrEqual(2)
      expect(denialResults).toBeGreaterThanOrEqual(2)
      expect(markerAbsent).toBe(true)
      const preTools = events.filter((event) => event.event === 'PreToolUse')
      expect(preTools).toHaveLength(2)
      expect(preTools.every((event) => event.canonicalToolIntent)).toBe(true)
      expect(preTools.map((event) => event.acknowledgementDelivered).sort()).toEqual([false, true])
      expect(events.find((event) => event.event === 'SessionStart')).toMatchObject({
        freshStartup: true
      })
      expect(events.some((event) => event.event === 'SubagentStart')).toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      agentHookServer.stop()
      await rm(root, { recursive: true, force: true })
    }
  },
  35000
)
