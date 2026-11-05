import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { runEngineDeviceLogin } from './engine-device-login-process'

const mock = vi.hoisted(() => ({
  spawn: vi.fn(),
  reserve: vi.fn(),
  record: vi.fn(),
  release: vi.fn(),
  cancel: vi.fn()
}))
vi.mock('../provider-process/managed-provider-process', () => ({
  spawnManagedProviderProcess: (...args: unknown[]) => mock.spawn(...args)
}))
vi.mock('./engine-writer-ownership', () => ({
  reserveEngineWriter: (...args: unknown[]) => mock.reserve(...args)
}))
vi.mock('./codex-engine-capability', () => ({ supportsCodexEngineGateway: () => true }))
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'opka-engine-device-'))
  mock.spawn.mockReset()
  mock.record.mockReset()
  mock.release.mockReset()
  mock.cancel.mockReset()
  mock.reserve.mockReset()
  mock.reserve.mockReturnValue({
    recordGroup: mock.record,
    release: mock.release,
    cancelBeforeSpawn: mock.cancel
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const binaryPath = join(directory, 'engine')
  writeFileSync(binaryPath, 'synthetic-pinned-engine')
  const child = Object.assign(createFakePipedChild(), {
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  let verdict: 'live' | 'exited' = 'live'
  let resolveExit = (): void => {}
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  const finish = () => {
    verdict = 'exited'
    resolveExit()
    child.emit('close', 0, null)
  }
  const close = vi.fn(async () => {
    finish()
    return { root: 'exited', tree: null }
  })
  mock.spawn.mockReturnValue({
    child,
    exitPromise,
    get rootVerdict() {
      return verdict
    },
    close
  })
  return {
    child,
    finish,
    close,
    options: {
      binaryPath,
      expectedSha256: createHash('sha256').update('synthetic-pinned-engine').digest('hex'),
      memoryMiB: 128,
      directory: join(directory, 'runtime'),
      authDirectory: join(directory, 'auth'),
      signal: new AbortController().signal,
      onPrompt: vi.fn(),
      assertExclusiveRuntimeDirectory: vi.fn()
    }
  }
}
async function started() {
  await vi.waitFor(() => expect(mock.spawn).toHaveBeenCalledTimes(1))
}
it('uses engine device mode, no browser/server, isolated private config and transient prompt only', async () => {
  const f = fixture()
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-not-inherited')
  const done = runEngineDeviceLogin({
    ...f.options,
    networkProxySettings: { httpProxyUrl: 'http://127.0.0.1:2081' }
  })
  await started()
  const [launch, policy] = mock.spawn.mock.calls[0]
  expect(launch.args).toContain('--codex-device-login')
  expect(launch.args).toContain('--no-browser')
  expect(launch.env).toMatchObject({ HTTP_PROXY: 'http://127.0.0.1:2081' })
  expect(launch.env).not.toHaveProperty('OPENAI_API_KEY')
  expect(policy).toMatchObject({ discardOutput: true, inheritedEnv: {}, lifetime: 'one-shot' })
  const config = JSON.parse(readFileSync(join(f.options.directory, 'config.json'), 'utf8'))
  expect(config.oauth['auth-dir']).toBe(f.options.authDirectory)
  expect(config).not.toHaveProperty('api-keys')
  f.child.stdout.write(
    'Codex device URL: https://auth.openai.com/codex/device\nCodex device code: ABCD-12345\nprivate-not-forwarded'
  )
  expect(f.options.onPrompt).not.toHaveBeenCalled()
  policy.onGroupProven({ pgid: 12345, startedAt: 'synthetic-group-start' })
  expect(mock.record).toHaveBeenCalledWith({ pgid: 12345, startedAt: 'synthetic-group-start' })
  expect(f.options.onPrompt).toHaveBeenCalledWith({
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-12345'
  })
  f.finish()
  await expect(done).resolves.toEqual({ verdict: 'exited', closed: true, cancelled: false })
})
it('aborts with the managed close ladder and does not publish another prompt', async () => {
  const f = fixture()
  const controller = new AbortController()
  const done = runEngineDeviceLogin({ ...f.options, signal: controller.signal })
  await started()
  controller.abort()
  f.child.stdout.write(
    'Codex device URL: https://auth.openai.com/codex/device\nCodex device code: ABCD-12345\n'
  )
  await expect(done).resolves.toEqual({ verdict: 'exited', closed: true, cancelled: true })
  expect(f.close).toHaveBeenCalledTimes(1)
  expect(f.options.onPrompt).not.toHaveBeenCalled()
})
it('retains an unverifiable ownership receipt and refuses to report closed credentials', async () => {
  const f = fixture()
  mock.release.mockImplementation(() => {
    throw new Error('synthetic group still present')
  })
  const done = runEngineDeviceLogin(f.options)
  await started()
  f.finish()
  await expect(done).resolves.toEqual({ verdict: 'exited', closed: false, cancelled: false })
  expect(mock.cancel).not.toHaveBeenCalled()
})
it('checks durable previous-writer ownership before config or a new spawn', async () => {
  const f = fixture()
  mock.reserve.mockImplementation(() => {
    throw new Error('synthetic previous writer alive')
  })
  await expect(runEngineDeviceLogin(f.options)).rejects.toThrow(/previous writer/)
  expect(mock.spawn).not.toHaveBeenCalled()
})
it('closes a child without exposing its prompt when group recording fails', async () => {
  const f = fixture()
  mock.record.mockImplementation(() => {
    throw new Error('synthetic private write failure')
  })
  const done = runEngineDeviceLogin(f.options)
  await started()
  f.child.stdout.write(
    'Codex device URL: https://auth.openai.com/codex/device\nCodex device code: ABCD-12345\n'
  )
  mock.spawn.mock.calls[0][1].onGroupProven({ pgid: 12345, startedAt: 'synthetic-start' })
  await expect(done).resolves.toMatchObject({ cancelled: true })
  expect(f.options.onPrompt).not.toHaveBeenCalled()
})
it('rejects an unpinned binary before config/spawn', async () => {
  const f = fixture()
  await expect(
    runEngineDeviceLogin({ ...f.options, expectedSha256: '0'.repeat(64) })
  ).rejects.toThrow(/pinned SHA256/)
  expect(mock.spawn).not.toHaveBeenCalled()
})
