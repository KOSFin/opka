import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createEngineRuntimeLaunch } from './engine-runtime'
import { engineLoopbackReady } from './engine-loopback-readiness'

afterEach(() => vi.unstubAllEnvs())
const files = { directory: '/isolated-profile', configPath: '/isolated-profile/config.json' }
it('preserves only allowlisted proxy environment when host settings are absent', () => {
  vi.stubEnv('HTTPS_PROXY', 'http://proxy.invalid:8080')
  vi.stubEnv('NO_PROXY', 'localhost,127.0.0.1')
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-not-inherited')
  vi.stubEnv('GITSTORE_GIT_URL', 'synthetic-not-inherited')
  const directory = mkdtempSync(join(tmpdir(), 'opka-engine-env-'))
  try {
    const env = createEngineRuntimeLaunch(
      { directory, configPath: join(directory, 'config.json') },
      join(directory, 'engine'),
      128
    ).env
    expect(env).toMatchObject({
      HTTPS_PROXY: 'http://proxy.invalid:8080',
      NO_PROXY: 'localhost,127.0.0.1'
    })
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(env).not.toHaveProperty('GITSTORE_GIT_URL')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
it('explicit execution-host proxy settings replace ambient proxy/bypass and empty settings opt out', () => {
  vi.stubEnv('HTTPS_PROXY', 'http://ambient.invalid:8080')
  vi.stubEnv('NO_PROXY', '*')
  const directory = mkdtempSync(join(tmpdir(), 'opka-engine-env-'))
  try {
    const launch = (settings: { httpProxyUrl?: string; httpProxyBypassRules?: string }) =>
      createEngineRuntimeLaunch({ ...files, directory }, join(directory, 'engine'), 128, settings)
    expect(
      launch({
        httpProxyUrl: 'socks5://127.0.0.1:2080',
        httpProxyBypassRules: 'localhost;127.0.0.1'
      }).env
    ).toMatchObject({ HTTPS_PROXY: 'socks5://127.0.0.1:2080', NO_PROXY: 'localhost,127.0.0.1' })
    expect(launch({}).env).not.toHaveProperty('HTTPS_PROXY')
    expect(launch({}).env).not.toHaveProperty('NO_PROXY')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
it('readiness uses a direct loopback socket rather than global fetch or environment proxy', async () => {
  vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1')
  const server = createServer((_req, res) => {
    res.writeHead(200)
    res.end('not-retained')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP fixture')
    }
    expect(await engineLoopbackReady(address.port, 'synthetic-client-key', 500)).toBe(true)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
