import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createOwnedClaudeNativePty } from './claude-native-owned-pty-test-fixture'
import { writeClaudeNativeToolProbeResponse } from './claude-native-tool-probe-response'
import { PANE } from '../agent-hooks/server.test-fixtures'

const enabled = process.platform === 'linux' && process.env.OPKA_SYNTHETIC_LOOPBACK_SCOPE === '1'
it.skipIf(!enabled)(
  'publishes a coherent account before public Mod prompt admission without losing native user input',
  async () => {
    const executable = process.env.OPKA_SYNTHETIC_CLAUDE_BINARY
    if (!executable) {
      throw new Error('Explicit qualified synthetic native executable required.')
    }
    const root = await mkdtemp(join(tmpdir(), 'opka-mod-prompt-publication-')),
      config = join(root, 'config'),
      plugin = join(root, 'public-mod')
    await mkdir(config)
    await mkdir(join(plugin, '.claude-plugin'), { recursive: true })
    await mkdir(join(plugin, 'hooks'))
    const identities = ['A', 'B'].map((label) => ({
      label,
      accountUuid: randomUUID(),
      organizationUuid: randomUUID(),
      emailAddress: `${label.toLowerCase()}@example.invalid`,
      token: `sk-ant-oat01-synthetic-mod-prompt-${label.toLowerCase()}`
    }))
    const writePair = async (index: number) => {
      const identity = identities[index]
      const metadata = JSON.parse(await readFile(join(config, '.claude.json'), 'utf8'))
      await writeFile(
        join(config, '.credentials.next'),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: identity.token,
            expiresAt: Date.now() + 3600000,
            scopes: ['user:inference', 'user:profile']
          }
        }),
        { mode: 0o600 }
      )
      await writeFile(
        join(config, '.metadata.next'),
        JSON.stringify({
          ...metadata,
          oauthAccount: {
            accountUuid: identity.accountUuid,
            organizationUuid: identity.organizationUuid,
            emailAddress: identity.emailAddress
          }
        }),
        { mode: 0o600 }
      )
      await rename(join(config, '.credentials.next'), join(config, '.credentials.json'))
      await rename(join(config, '.metadata.next'), join(config, '.claude.json'))
    }
    const prompts: { origin: string; meta: boolean }[] = [],
      requests: {
        bearer: string
        metadata: string
        retainedFirst: boolean
        retainedSecond: boolean
      }[] = []
    let loaded = false,
      completed = 0,
      output = ''
    let pty: Awaited<ReturnType<typeof createOwnedClaudeNativePty>> | undefined
    const first = 'synthetic-public-mod-first-unique',
      second = 'synthetic-public-mod-second-unique'
    const server = createServer(async (request, response) => {
      let text = ''
      for await (const chunk of request) {
        text += chunk
        if (text.length > 2 * 1024 * 1024) {
          response.writeHead(413).end()
          return
        }
      }
      const body = JSON.parse(text || '{}')
      if (request.url === '/loaded') {
        loaded = true
        response.writeHead(200).end('{}')
        return
      }
      if (request.url === '/complete') {
        completed++
        response.writeHead(200).end('{}')
        return
      }
      if (request.url === '/prompt') {
        prompts.push({
          origin: typeof body.origin === 'string' ? body.origin : 'none',
          meta: body.meta === true
        })
        if (prompts.length === 2) {
          await writePair(1)
        }
        response.writeHead(200).end('{}')
        return
      }
      if (request.url?.startsWith('/v1/messages')) {
        const messages = JSON.stringify(body.messages ?? [])
        if (messages.includes(first) && body.model === 'claude-sonnet-4-5') {
          const authorization = request.headers.authorization
          const metadata = JSON.stringify(body.metadata?.user_id ?? '')
          requests.push({
            bearer:
              identities.find((identity) => authorization === `Bearer ${identity.token}`)?.label ??
              'none',
            metadata:
              identities.find((identity) => metadata.includes(identity.accountUuid))?.label ??
              'none',
            retainedFirst: messages.includes(first),
            retainedSecond: messages.includes(second)
          })
        }
        writeClaudeNativeToolProbeResponse(response, body.model, [])
        return
      }
      response.writeHead(200).end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address !== 'object') {
        throw new Error('Missing synthetic loopback endpoint.')
      }
      const base = `http://127.0.0.1:${address.port}`
      await writeFile(
        join(plugin, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'opka-prompt-admission-fixture', version: '0.0.1' })
      )
      await writeFile(
        join(plugin, 'hooks', 'hooks.json'),
        JSON.stringify({ modules: ['./register.js'] })
      )
      await writeFile(
        join(plugin, 'hooks', 'register.js'),
        `async function emit($,path,body={}){const response=await $.http.fetch(${JSON.stringify(base)}+path,{method:'POST',body:JSON.stringify(body)});if(!response.ok)throw new Error('Synthetic admission refused')};export function register(on){on('session.start',async($,e,next)=>{const result=await next(e);await emit($,'/loaded');return result});on('prompt.submit',async($,e,next)=>{await emit($,'/prompt',{origin:e.origin.kind,meta:e.isMeta===true});return next(e)});on('turn.complete',async($,e,next)=>{const result=await next(e);if(!e.agentId)await emit($,'/complete');return result})}`
      )
      await writeFile(join(config, 'settings.json'), '{}')
      await writeFile(
        join(config, '.claude.json'),
        JSON.stringify({
          hasCompletedOnboarding: true,
          theme: 'dark',
          projects: { [root]: { hasTrustDialogAccepted: true } }
        }),
        { mode: 0o600 }
      )
      await writePair(0)
      pty = await createOwnedClaudeNativePty({
        executable,
        args: [
          '--model',
          'claude-sonnet-4-5',
          '--strict-mcp-config',
          '--setting-sources',
          'user',
          '--plugin-dir',
          plugin
        ],
        cwd: root,
        paneKey: PANE,
        env: {
          HOME: root,
          CLAUDE_CONFIG_DIR: config,
          ANTHROPIC_BASE_URL: base,
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          TERM: 'xterm-256color',
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
      await vi.waitFor(() => expect(loaded).toBe(true), { timeout: 5000 })
      await new Promise((resolve) => setTimeout(resolve, 1000))
      pty.write(`${first}\r`)
      await vi.waitFor(() => expect(completed).toBe(1), { timeout: 7000 })
      pty.write(`${second}\r`)
      await vi.waitFor(() => expect(completed).toBe(2), { timeout: 7000 })
      expect(requests).toEqual([
        { bearer: 'A', metadata: 'A', retainedFirst: true, retainedSecond: false },
        { bearer: 'B', metadata: 'B', retainedFirst: true, retainedSecond: true }
      ])
      expect(prompts).toHaveLength(2)
      expect(pty.readOwner()).toBeTruthy()
    } finally {
      const receipt = {
        prompts,
        requests,
        completed,
        loaded,
        physicalOwner: !!pty?.readOwner(),
        pid: pty?.pid,
        incarnationId: pty?.incarnationId
      }
      if (process.env.OPKA_NATIVE_MOD_PROMPT_RECEIPT) {
        await writeFile(
          process.env.OPKA_NATIVE_MOD_PROMPT_RECEIPT,
          JSON.stringify(receipt, null, 2),
          { mode: 0o600 }
        )
      }
      if (process.env.OPKA_NATIVE_MOD_PROMPT_TRANSCRIPT) {
        await writeFile(process.env.OPKA_NATIVE_MOD_PROMPT_TRANSCRIPT, output, { mode: 0o600 })
      }
      console.info('Synthetic public Mod prompt publication receipt', receipt)
      await pty?.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
  25000
)
