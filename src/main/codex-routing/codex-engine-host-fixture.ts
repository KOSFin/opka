import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { CodexEngineHost, type CodexEngineHostOptions } from './codex-engine-host'
import { publishEngineGrant, type EngineGrantAccount } from './engine-grant-files'
import type { CodexPoolSelectionState } from './codex-pool-turn-session'
import type { EngineDeviceLoginOptions } from './engine-device-login-process'
import type { EngineRuntimeHandle } from './engine-runtime'
import type { NativeEngineLaunch, NativeEngineSelection } from './codex-engine-sessions'

vi.mock('./engine-asset-cache', () => ({ ensurePinnedEngineAsset: vi.fn() }))
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
export const grantContents = (providerAccountId: string, access = 'synthetic-access') =>
  JSON.stringify({
    type: 'codex',
    account_id: providerAccountId,
    access_token: access,
    refresh_token: 'synthetic-refresh',
    id_token: `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: providerAccountId } })).toString('base64url')}.synthetic`
  })
export function engineHostFixture(
  timeout = 1000,
  settings: {
    dbPath?: string
    recordQuotaFailure?: CodexEngineHostOptions['recordQuotaFailure']
    ensureAsset?: CodexEngineHostOptions['ensureAsset']
  } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'opka-engine-host-'))
  const db = new OrchestrationDb(settings.dbPath ?? ':memory:')
  const accounts = new Map<string, EngineGrantAccount>(
    [1, 2].map((n) => {
      const account = {
        id: `10000000-0000-4000-8000-00000000000${n}`,
        providerAccountId: `synthetic-provider-${n}`,
        rosterRevision: 'r1'
      }
      return [account.id, account]
    })
  )
  const [a, b] = [...accounts.values()]
  for (const account of accounts.values()) {
    publishEngineGrant(directory, account, grantContents(account.providerAccountId))
  }
  const state: CodexPoolSelectionState = {
    manualAccountId: a.id,
    candidates: [...accounts.values()].map((account) => ({
      accountId: account.id,
      quotaIdentity: account.providerAccountId,
      auth: 'ready',
      quota: 'available',
      usedPercent: 10
    })),
    policy: {
      id: 'existing-roster',
      provider: 'codex',
      revision: 1,
      strategy: 'sequential',
      applyToNewWork: true,
      rotation: 'on-limit',
      unknownQuota: 'exclude',
      allowReserve: false,
      members: [...accounts.values()].map((account, index) => ({
        accountId: account.id,
        priority: index + 1,
        weight: 1,
        maxConcurrent: 2,
        state: 'enabled',
        role: 'primary'
      }))
    }
  }
  const stats: {
    starts: number
    stopAttempts: number
    residents: number
    maximum: number
    provisions: number
    models: string[]
    bindings: NativeEngineSelection[]
    stopVerdict: 'exited' | 'unverifiable'
    omitPrefix: boolean
    failAfterSpawn: boolean
    safe: boolean
    holdResponse: boolean
    quotaOnce: boolean
  } = {
    starts: 0,
    stopAttempts: 0,
    residents: 0,
    maximum: 0,
    provisions: 0,
    models: [],
    bindings: [],
    stopVerdict: 'exited',
    omitPrefix: false,
    failAfterSpawn: false,
    safe: true,
    holdResponse: false,
    quotaOnce: false
  }
  const servers = new Set<ReturnType<typeof createServer>>()
  let login: EngineDeviceLoginOptions | undefined
  let finishLogin = () => {}
  const options: CodexEngineHostOptions = {
    directory,
    cacheDirectory: join(directory, 'asset-cache'),
    db,
    memoryMiB: 128,
    maxRequestBytes: 65536,
    transitionTimeoutMs: timeout,
    recordQuotaFailure: settings.recordQuotaFailure,
    readAccount: (id) => accounts.get(id) ?? null,
    listAccounts: () => [...accounts.values()],
    readSelectionState: () => state,
    assertExclusiveProfile: () => {},
    assertEnrollmentIdle: () => {},
    withAccountMutationLease: (operation) => operation(),
    ensureAsset:
      settings.ensureAsset ??
      (async () => {
        stats.provisions++
        return {
          binaryPath: join(directory, 'synthetic-engine'),
          expectedSha256: 'a'.repeat(64),
          archiveSha256: 'b'.repeat(64),
          version: 'synthetic',
          reused: true
        }
      }),
    runLogin: async (opts) => {
      login = opts
      opts.onPrompt({
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-12345'
      })
      writeFileSync(
        join(opts.authDirectory, 'new.json'),
        grantContents(a.providerAccountId, 'synthetic-new'),
        { mode: 0o600 }
      )
      await new Promise<void>((resolve) => {
        finishLogin = resolve
        opts.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return { verdict: 'exited', closed: true, cancelled: opts.signal.aborted }
    },
    startRuntime: async (opts) => {
      stats.starts++
      stats.residents++
      stats.maximum = Math.max(stats.maximum, stats.residents)
      const authDirectory =
        opts.auth.kind === 'ready-engine-auth'
          ? opts.auth.directory
          : join(directory, 'active-auth')
      const prefixes = readdirSync(authDirectory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          const contents: unknown = JSON.parse(readFileSync(join(authDirectory, name), 'utf8'))
          return contents && typeof contents === 'object' && 'prefix' in contents
            ? contents.prefix
            : undefined
        })
        .filter((prefix) => typeof prefix === 'string')
      const server = createServer(async (req, res) => {
        if (req.url === '/v1/models') {
          res.end(
            JSON.stringify({
              data: stats.omitPrefix
                ? []
                : prefixes.map((prefix) => ({ id: `${prefix}/synthetic` }))
            })
          )
          return
        }
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        const payload: unknown = JSON.parse(Buffer.concat(chunks).toString())
        if (
          payload &&
          typeof payload === 'object' &&
          'model' in payload &&
          typeof payload.model === 'string'
        ) {
          stats.models.push(payload.model)
        }
        if (stats.holdResponse) {
          await new Promise<void>((resolve) => res.once('close', resolve))
          return
        }
        if (stats.quotaOnce && stats.models.length === 1) {
          res.writeHead(429, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({ error: { type: 'usage_limit_reached', code: 'usage_limit_reached' } })
          )
          return
        }
        res.end(JSON.stringify({ output: 'synthetic-only' }))
      })
      servers.add(server)
      await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve))
      let verdict: EngineRuntimeHandle['verdict'] = 'live'
      const runtime: EngineRuntimeHandle = {
        host: '127.0.0.1',
        port: opts.port,
        clientKey: 'synthetic-local-key'.repeat(3),
        binarySha256: opts.expectedSha256,
        configPath: join(directory, 'synthetic-config'),
        authReference: opts.auth,
        get verdict() {
          return verdict
        },
        stop: async () => {
          stats.stopAttempts++
          if (stats.stopVerdict === 'unverifiable') {
            verdict = 'unverifiable'
            return { root: 'unverifiable', tree: null }
          }
          if (servers.delete(server)) {
            await new Promise<void>((resolve) => server.close(() => resolve()))
            stats.residents--
          }
          verdict = 'exited'
          return { root: 'exited', tree: null }
        },
        forceStop: async () => 'unverifiable'
      }
      opts.onStarted?.(runtime)
      if (stats.failAfterSpawn) {
        throw new Error('Synthetic readiness failed after process start.')
      }
      return runtime
    }
  }
  const host = new CodexEngineHost(options)
  const launches: NonNullable<Awaited<ReturnType<typeof host.prepareNativeLaunch>>>[] = []
  const launch = async (
    id = `launch-${launches.length}`,
    readBoundary?: NativeEngineLaunch['readBoundary']
  ) => {
    const value = await host.prepareNativeLaunch({
      launchId: id,
      ownerPrefix: id,
      canSwitch: () => stats.safe,
      canReplaceRejectedRequest: () => stats.safe,
      readBoundary,
      onAccountSelected: (binding) => stats.bindings.push(binding)
    })
    if (!value) {
      throw new Error('Synthetic routing launch unexpectedly bypassed.')
    }
    launches.push(value)
    return value
  }
  return {
    host,
    options,
    directory,
    db,
    accounts,
    a,
    b,
    state,
    stats,
    launch,
    login: () => login,
    finishLogin: () => finishLogin(),
    cleanup: async () => {
      stats.safe = true
      stats.stopVerdict = 'exited'
      launches.forEach((l) => l.close('exited'))
      await host.stop()
      for (const server of servers) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
export async function syntheticTurn(launch: { baseUrl: string; apiKey: string }, turn = '1') {
  const response = await fetch(`${launch.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${launch.apiKey}`,
      'content-type': 'application/json',
      'x-codex-turn-metadata': JSON.stringify({ thread_id: 'synthetic-thread', turn_id: turn })
    },
    body: JSON.stringify({ model: 'synthetic', input: 'local fixture' })
  })
  await response.arrayBuffer()
  return response
}
