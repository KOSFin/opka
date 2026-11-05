import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type * as AppServerSession from './codex-app-server-session'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'

const mocks = vi.hoisted(() => ({ session: vi.fn(), process: vi.fn() }))
vi.mock('../codex-routing/native-codex-policy-scope', () => ({
  assertNativeCodexPolicyScope: async () => {}
}))
vi.mock('./codex-app-server-session', async (original) => ({
  ...(await original<typeof AppServerSession>()),
  runCodexAppServerSession: mocks.session
}))
vi.mock('@orca/process-host', () => ({ runProcess: mocks.process }))
import {
  deriveCodexHookHashes,
  listCodexHooks,
  probeCodexVersion
} from './codex-hook-trust-derivation'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})

it('scratch derivation strips inherited identity/key/storage env and never reaches an auth trap', async () => {
  vi.stubEnv('CODEX_ACCESS_TOKEN', 'synthetic-pat-do-not-forward')
  vi.stubEnv('CODEX_API_KEY', 'synthetic-codex-key')
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-openai-key')
  vi.stubEnv('CODEX_SQLITE_HOME', '/synthetic/original-sqlite-do-not-write')
  let calls = 0
  const trap = createServer((request, response) => {
    calls++
    request.resume()
    response.writeHead(400).end()
  })
  trap.listen(0, '127.0.0.1')
  await once(trap, 'listening')
  const address = trap.address()
  if (!address || typeof address === 'string') {
    throw new Error('Private auth trap unavailable')
  }
  try {
    mocks.session.mockImplementation(
      async (invocation: AppServerSession.CodexAppServerInvocation) => {
        const child = resolveProviderChildEnv(invocation, process.env)
        if (child.CODEX_ACCESS_TOKEN) {
          await fetch(`http://127.0.0.1:${address.port}/auth`, {
            signal: AbortSignal.timeout(1000)
          })
        }
        for (const key of [
          'CODEX_ACCESS_TOKEN',
          'CODEX_API_KEY',
          'OPENAI_API_KEY',
          'CODEX_SQLITE_HOME'
        ]) {
          expect(child[key]).toBeUndefined()
        }
        expect(child.CODEX_HOME).toContain('orca-codex-hook-trust-')
        expect(invocation.args).toContain('cli_auth_credentials_store="file"')
        return { data: [] }
      }
    )
    await deriveCodexHookHashes('/synthetic/codex', 'synthetic-hook', 'synthetic-native')
    expect(mocks.session).toHaveBeenCalledTimes(1)
    expect(calls).toBe(0)
    expect(process.env.CODEX_ACCESS_TOKEN).toBe('synthetic-pat-do-not-forward')
    expect(process.env.CODEX_SQLITE_HOME).toBe('/synthetic/original-sqlite-do-not-write')
  } finally {
    trap.closeAllConnections()
    await new Promise<void>((done) => trap.close(() => done()))
  }
})

it('explicit user-home hooks/list retains its existing auth/config semantics', async () => {
  vi.stubEnv('CODEX_ACCESS_TOKEN', 'synthetic-user-requested-identity')
  mocks.session.mockImplementation(
    async (invocation: AppServerSession.CodexAppServerInvocation) => {
      const child = resolveProviderChildEnv(invocation, process.env)
      expect(child.CODEX_ACCESS_TOKEN).toBe('synthetic-user-requested-identity')
      expect(child.CODEX_HOME).toBe('/synthetic/explicit-user-home')
      expect(invocation.args).not.toContain('cli_auth_credentials_store="file"')
      return { data: [] }
    }
  )
  await listCodexHooks('/synthetic/codex', '/synthetic/explicit-user-home', '/synthetic/workspace')
})

it('version scratch subprocess receives no inherited auth or foreign SQLite location', async () => {
  vi.stubEnv('CODEX_ACCESS_TOKEN', 'synthetic-version-pat')
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-version-key')
  vi.stubEnv('CODEX_SQLITE_HOME', '/synthetic/foreign-state')
  mocks.process.mockImplementation(async (spec: { env: NodeJS.ProcessEnv; args: string[] }) => {
    expect(spec.env.CODEX_ACCESS_TOKEN).toBeUndefined()
    expect(spec.env.OPENAI_API_KEY).toBeUndefined()
    expect(spec.env.CODEX_SQLITE_HOME).toBeUndefined()
    expect(spec.args).toContain('cli_auth_credentials_store="file"')
    return { code: 0, stdout: 'codex-cli synthetic', stderr: '' }
  })
  expect(await probeCodexVersion('/synthetic/codex')).toBe('codex-cli synthetic')
  expect(process.env.CODEX_ACCESS_TOKEN).toBe('synthetic-version-pat')
})

it('never treats the real default HOME as an isolated scratch listing', async () => {
  await expect(
    listCodexHooks('/synthetic/codex', null, '/synthetic/cwd', { scratch: true })
  ).rejects.toThrow('explicit isolated HOME')
  expect(mocks.session).not.toHaveBeenCalled()
})
