import { createServer } from 'node:https'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { measureOwnedNativeProbeDirectory } from './claude-native-probe-test-growth'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { runAgentModelCatalogListing } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { refreshClaudeNativeAccess } from './claude-native-refresh-authority'

const enabled =
  process.platform === 'linux' &&
  process.env.OPKA_SYNTHETIC_LOOPBACK_SCOPE === '1' &&
  Boolean(process.env.OPKA_SYNTHETIC_CLAUDE_BINARY)

it.skipIf(!enabled)(
  'runs the qualified native usage command through the production authority and supervisor without inference',
  async () => {
    const cli = process.env.OPKA_SYNTHETIC_CLAUDE_BINARY
    if (!cli) {
      throw new Error('Missing isolated native fixture')
    }
    const root = await mkdtemp(join(tmpdir(), 'opka-native-authority-'))
    const config = join(root, 'config')
    const project = join(root, 'project')
    await Promise.all([mkdir(config), mkdir(project)])
    const identity = {
      accountUuid: randomUUID(),
      organizationUuid: randomUUID(),
      emailAddress: 'synthetic@example.invalid'
    }
    const credentialPath = join(config, '.credentials.json')
    const old = {
      accessToken: 'sk-ant-oat01-synthetic-expired',
      refreshToken: 'synthetic-refresh-old',
      expiresAt: Date.now() - 60_000,
      scopes: ['user:inference', 'user:profile']
    }
    const freshToken = 'sk-ant-oat01-synthetic-current'
    await writeFile(credentialPath, JSON.stringify({ claudeAiOauth: old }), { mode: 0o600 })
    const state = JSON.stringify({
      oauthAccount: identity,
      hasCompletedOnboarding: true,
      projects: { [project]: { hasTrustDialogAccepted: true } }
    })
    await writeFile(join(config, '.claude.json'), state, { mode: 0o600 })
    await writeFile(join(config, '.claude-custom-oauth.json'), state, { mode: 0o600 })
    const key = join(root, 'tls.key')
    const certificate = join(root, 'tls.crt')
    const openssl = await runProcess({
      program: '/usr/bin/openssl',
      args: [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        certificate,
        '-days',
        '1',
        '-subj',
        '/CN=claude.fedstart.com',
        '-addext',
        'subjectAltName=DNS:claude.fedstart.com'
      ],
      input: '',
      timeoutMs: 10_000
    })
    expect(openssl.code).toBe(0)
    const nativeAbort = new AbortController()
    let refresh = 0
    let inference = 0
    const server = createServer(
      { key: await readFile(key), cert: await readFile(certificate) },
      async (request, response) => {
        let body = ''
        for await (const chunk of request) {
          body += chunk
          if (body.length > 65536) {
            response.writeHead(413).end()
            return
          }
        }
        const path = new URL(request.url ?? '/', 'https://localhost').pathname
        if (path === '/v1/messages') {
          inference++
          nativeAbort.abort()
          response.writeHead(503).end()
          return
        }
        if (path === '/v1/oauth/token') {
          if (!body.includes(old.refreshToken) || !body.includes('refresh_token')) {
            response.writeHead(400).end()
            return
          }
          refresh++
          response.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              access_token: freshToken,
              refresh_token: 'synthetic-refresh-rotated',
              expires_in: 86400,
              token_type: 'Bearer',
              scope: old.scopes.join(' ')
            })
          )
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      }
    )
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(443, '127.0.0.1', resolve)
    })
    try {
      const growth: { files: number; bytes: number }[] = []
      const refreshNative = () =>
        refreshClaudeNativeAccess(
          {
            configDir: config,
            writerDirectory: join(root, 'writer'),
            expectedIdentity: identity,
            qualifiedVersion: '2.1.318',
            launch: { command: cli, args: [], cwd: project },
            assertExclusive() {}
          },
          {
            signal: nativeAbort.signal,
            run: (launch, options) =>
              runAgentModelCatalogListing(
                {
                  ...launch,
                  env: {
                    ...launch.env,
                    HOME: root,
                    NODE_EXTRA_CA_CERTS: certificate,
                    ANTHROPIC_BASE_URL: 'https://claude.fedstart.com',
                    CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://claude.fedstart.com'
                  },
                  envToDelete: launch.envToDelete?.filter(
                    (key) => key !== 'ANTHROPIC_BASE_URL' && key !== 'CLAUDE_CODE_CUSTOM_OAUTH_URL'
                  )
                },
                options
              )
          }
        )
      const executions = process.env.OPKA_SYNTHETIC_REFRESH_RUNS === '1' ? 1 : 5
      for (let index = 0; index < executions; index++) {
        await writeFile(credentialPath, JSON.stringify({ claudeAiOauth: old }), { mode: 0o600 })
        const actual = await refreshNative()
        expect(actual.access.accessToken).toBe(freshToken)
        expect(actual.identity).toEqual(identity)
        expect(actual.access).not.toHaveProperty('refreshToken')
        growth.push(await measureOwnedNativeProbeDirectory(root))
      }
      if (executions === 1) {
        expect((await refreshNative()).access.accessToken).toBe(freshToken)
        growth.push(await measureOwnedNativeProbeDirectory(root))
      }
      expect(new Set(growth.map((entry) => entry.files)).size).toBe(1)
      expect(
        Math.max(...growth.map((entry) => entry.bytes)) -
          Math.min(...growth.map((entry) => entry.bytes))
      ).toBeLessThan(4096)
      console.info('Synthetic native authority whole-HOME growth', {
        executions: growth.length,
        growth
      })
      expect(refresh).toBe(executions)
      expect(inference).toBe(0)
      expect(JSON.parse(await readFile(credentialPath, 'utf8')).claudeAiOauth.refreshToken).toBe(
        'synthetic-refresh-rotated'
      )
      await expect(readFile(join(root, 'writer', 'writer-owner.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } catch (error) {
      const credentials = JSON.parse(await readFile(credentialPath, 'utf8')).claudeAiOauth ?? {}
      const global =
        JSON.parse(await readFile(join(config, '.claude.json'), 'utf8')).oauthAccount ?? {}
      console.info('Synthetic native authority diagnostic', {
        refresh,
        inference,
        freshTokenWritten: credentials.accessToken === freshToken,
        freshExpiry:
          typeof credentials.expiresAt === 'number' && credentials.expiresAt > Date.now(),
        sourceAccountMatched: global.accountUuid === identity.accountUuid,
        sourceOrganizationMatched: global.organizationUuid === identity.organizationUuid,
        credentialFieldNames: Object.keys(credentials).sort()
      })
      throw error
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (
        existsSync(join(root, 'writer', 'writer-owner.json')) ||
        existsSync(join(root, 'writer', 'writer-owner.json.next'))
      ) {
        console.info('Synthetic native writer remains unproven; private fixture preserved.')
      } else {
        await rm(root, { recursive: true, force: true })
      }
    }
  },
  55_000
)
