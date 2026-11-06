import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  prepareEngineRuntimeConfig,
  type EngineRuntimeConfigOptions
} from './engine-runtime-config'
import { createEngineRuntimeLaunch, startEngineRuntime } from './engine-runtime'
import { reserveEngineWriter } from './engine-writer-ownership'

const managed = vi.hoisted(() => ({
  verdict: 'live',
  spawn: vi.fn(),
  close: vi.fn(async () => ({ root: 'exited', tree: null })),
  ready: true
}))
vi.mock('./engine-loopback-readiness', () => ({ engineLoopbackReady: async () => managed.ready }))
vi.mock('./engine-writer-ownership', () => ({
  reserveEngineWriter: vi.fn(() => ({
    recordGroup: vi.fn(),
    cancelBeforeSpawn: vi.fn(),
    release: vi.fn()
  }))
}))
vi.mock('../provider-process/managed-provider-process', () => ({
  spawnManagedProviderProcess: (
    launch: unknown,
    options: { onGroupProven?: (group: { pgid: number; startedAt: string }) => void }
  ) => {
    managed.spawn(launch, options)
    options.onGroupProven?.({ pgid: 12345, startedAt: 'clock-tick:1234' })
    return {
      get rootVerdict() {
        return managed.verdict
      },
      close: managed.close
    }
  }
}))
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opka-engine-runtime-'))
  managed.verdict = 'live'
  managed.ready = true
  managed.spawn.mockClear()
  managed.close.mockClear()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})
function options(): EngineRuntimeConfigOptions {
  return {
    directory: join(root, 'runtime'),
    port: 18991,
    auth: { kind: 'synthetic-test', upstream: 'http://127.0.0.1:18992/v1' },
    maxRequestBytes: 16384,
    assertExclusiveRuntimeDirectory: vi.fn()
  }
}
function binary() {
  const path = join(root, 'synthetic-binary')
  writeFileSync(path, 'synthetic-not-executed')
  return {
    binaryPath: path,
    expectedSha256: createHash('sha256').update('synthetic-not-executed').digest('hex'),
    memoryMiB: 128
  }
}

it('writes private atomic fixed configuration without request, KV, panel or cooldown persistence', () => {
  const input = options()
  const files = prepareEngineRuntimeConfig(input)
  expect(JSON.parse(readFileSync(files.configPath, 'utf8'))).toMatchObject({
    server: {
      host: '127.0.0.1',
      'commercial-mode': true,
      'max-request-body-bytes': 16384,
      'kv-store': { disabled: true }
    },
    management: { 'secret-key': '', 'disable-control-panel': true },
    routing: { retry: { 'request-retry': 0 }, cooldown: { 'save-cooldown-status': false } },
    observability: {
      logs: { debug: false, 'logging-to-file': false, 'request-log': false },
      usage: { 'usage-statistics-enabled': false }
    }
  })
  if (process.platform !== 'win32') {
    expect(statSync(files.directory).mode & 0o777).toBe(0o700)
    expect(statSync(files.configPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(files.directory, 'empty-auth')).mode & 0o777).toBe(0o700)
  }
  expect(files.clientKey).toHaveLength(64)
  expect(input.assertExclusiveRuntimeDirectory).toHaveBeenCalledTimes(3)
})

it('recovers only its fixed reserved stage and stays bounded across repeated preparation', () => {
  const input = options()
  const first = prepareEngineRuntimeConfig(input)
  writeFileSync(`${first.configPath}.next`, 'crash-interrupted-private-config')
  for (let index = 0; index < 25; index++) {
    prepareEngineRuntimeConfig(input)
  }
  expect(readdirSync(first.directory).sort()).toEqual(['config.json', 'empty-auth'])
  expect(readdirSync(join(first.directory, 'empty-auth'))).toEqual([])
})

it('preserves the previous config if the exclusive lease is lost before publication', () => {
  const input = options()
  const first = prepareEngineRuntimeConfig(input)
  const before = readFileSync(first.configPath, 'utf8')
  let checks = 0
  input.assertExclusiveRuntimeDirectory = () => {
    if (++checks === 3) {
      throw new Error('lease lost')
    }
  }
  expect(() => prepareEngineRuntimeConfig(input)).toThrow('lease lost')
  expect(readFileSync(first.configPath, 'utf8')).toBe(before)
  expect(readdirSync(first.directory).sort()).toEqual(['config.json', 'empty-auth'])
})

it('does not create or alter files when the host cannot establish directory ownership', () => {
  const input = options()
  input.assertExclusiveRuntimeDirectory = () => {
    throw new Error('unverifiable owner')
  }
  expect(() => prepareEngineRuntimeConfig(input)).toThrow('unverifiable owner')
  expect(readdirSync(root)).toEqual([])
})

it.skipIf(process.platform === 'win32')(
  'refuses a linked staging path without modifying its target',
  () => {
    const input = options()
    const files = prepareEngineRuntimeConfig(input)
    const unrelated = join(root, 'user-history')
    writeFileSync(unrelated, 'preserve')
    symlinkSync(unrelated, `${files.configPath}.next`)
    expect(() => prepareEngineRuntimeConfig(input)).toThrow('regular owned files')
    expect(readFileSync(unrelated, 'utf8')).toBe('preserve')
  }
)

it('references already validated engine auth without reading or changing credential contents', () => {
  const input = options()
  const authDirectory = join(root, 'already-owned-engine-auth')
  mkdirSync(authDirectory)
  const authPath = join(authDirectory, 'synthetic-record')
  writeFileSync(authPath, 'not-read-by-launcher')
  input.auth = {
    kind: 'ready-engine-auth',
    directory: authDirectory,
    credentialId: 'synthetic-record',
    prefix: 'opka-account'
  }
  const files = prepareEngineRuntimeConfig(input)
  expect(JSON.parse(readFileSync(files.configPath, 'utf8'))).toMatchObject({
    oauth: { 'auth-dir': authDirectory },
    routing: { 'force-model-prefix': true }
  })
  expect(readdirSync(authDirectory)).toEqual(['synthetic-record'])
  expect(readFileSync(authPath, 'utf8')).toBe('not-read-by-launcher')
  expect(readdirSync(files.directory)).toEqual(['config.json'])
})

it('rejects non-loopback synthetic upstreams and invalid byte budgets', () => {
  expect(() =>
    prepareEngineRuntimeConfig({
      ...options(),
      auth: { kind: 'synthetic-test', upstream: 'https://provider.invalid/v1' }
    })
  ).toThrow('loopback')
  expect(() => prepareEngineRuntimeConfig({ ...options(), maxRequestBytes: 0 })).toThrow('budget')
})

it('uses a fixed Go budget and sanitized child environment without native account variables', () => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-native-key')
  vi.stubEnv('CODEX_HOME', 'synthetic-native-home')
  vi.stubEnv('GITHUB_TOKEN', 'synthetic-ambient-token')
  const launch = createEngineRuntimeLaunch(
    { directory: root, configPath: join(root, 'config.json') },
    join(root, 'engine'),
    128
  )
  expect(launch.env).toMatchObject({
    HOME: root,
    USERPROFILE: root,
    GOMAXPROCS: '1',
    GOMEMLIMIT: '128MiB',
    ORCA_BACKGROUND_LAUNCH: '1'
  })
  expect(launch.env).not.toHaveProperty('OPENAI_API_KEY')
  expect(launch.env).not.toHaveProperty('CODEX_HOME')
  expect(launch.env).not.toHaveProperty('GITHUB_TOKEN')
  expect(launch.args).toEqual(['-config', join(root, 'config.json'), '-local-model'])
})

it.skipIf(process.platform === 'win32')(
  'launches only the pinned binary in discard mode and returns the existing shutdown proof',
  async () => {
    const engine = await startEngineRuntime({ ...options(), ...binary() })
    expect(managed.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: join(root, 'runtime') }),
      expect.objectContaining({ discardOutput: true, inheritedEnv: {} })
    )
    expect(engine).toMatchObject({
      host: '127.0.0.1',
      port: 18991,
      binarySha256: binary().expectedSha256,
      verdict: 'live'
    })
    await expect(engine.stop()).resolves.toEqual({ root: 'exited', tree: null })
    expect(managed.close).toHaveBeenCalledTimes(1)
    expect(reserveEngineWriter).toHaveBeenCalledWith(
      expect.objectContaining({ directory: join(root, 'runtime') })
    )
  }
)

it('rejects hash mismatch before configuration or process creation', async () => {
  await expect(
    startEngineRuntime({ ...options(), ...binary(), expectedSha256: '0'.repeat(64) })
  ).rejects.toThrow('pinned SHA256')
  expect(managed.spawn).not.toHaveBeenCalled()
  expect(readdirSync(root)).toEqual(['synthetic-binary'])
})

it.skipIf(process.platform === 'win32')(
  'closes a child on readiness failure and never exposes a response body or raw diagnostics',
  async () => {
    managed.ready = false
    await expect(
      startEngineRuntime({ ...options(), ...binary(), startupTimeoutMs: 1 })
    ).rejects.toThrow('startup deadline')
    expect(managed.close).toHaveBeenCalledTimes(1)
  }
)

it('keeps the two-account native qualification fixture explicit, synthetic and private', () => {
  const input = options()
  input.auth = {
    kind: 'synthetic-test',
    upstream: 'http://127.0.0.1:18992/v1',
    accounts: ['A', 'B']
  }
  const config = JSON.parse(readFileSync(prepareEngineRuntimeConfig(input).configPath, 'utf8'))
  expect(config.routing['force-model-prefix']).toBe(true)
  expect(config.server).toMatchObject({ 'commercial-mode': true, 'kv-store': { disabled: true } })
  expect(config['api-keys'].codex).toEqual(
    ['A', 'B'].map((account) => ({
      name: `synthetic-${account}`,
      prefix: `synthetic-${account}`,
      'base-url': 'http://127.0.0.1:18992/v1',
      'request-retry': 0,
      models: ['probe', 'probe-a', 'probe-b', 'gpt-6.1-sol', 'gpt-6.1-terra'].map((name) => ({
        name
      })),
      keys: [{ 'api-key': `synthetic-${account}`, 'disable-codex-cloaking': true }]
    }))
  )
  input.auth = {
    kind: 'synthetic-test',
    upstream: 'https://external.invalid/v1',
    accounts: ['A', 'B']
  }
  expect(() => prepareEngineRuntimeConfig(input)).toThrow('loopback')
})

it('inherits service proxy and bypass settings for native enrollment without an app override', () => {
  vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:19877')
  vi.stubEnv('NO_PROXY', 'localhost,127.0.0.1')
  const files = prepareEngineRuntimeConfig(options())
  expect(createEngineRuntimeLaunch(files, binary().binaryPath, 128).env).toMatchObject({
    HTTPS_PROXY: 'http://127.0.0.1:19877',
    NO_PROXY: 'localhost,127.0.0.1'
  })
  expect(
    createEngineRuntimeLaunch(files, binary().binaryPath, 128, {
      httpProxyUrl: 'http://127.0.0.1:19878',
      httpProxyBypassRules: 'localhost'
    }).env
  ).toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:19878', NO_PROXY: 'localhost' })
})

it('passes the inherited proxy into the engine request transport, not only the OAuth environment', () => {
  vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:19877')
  const input = {
    ...options(),
    auth: { kind: 'device-enrollment' as const, directory: join(root, 'private-auth') }
  }
  const read = (settings?: { httpProxyUrl: string } | null) =>
    JSON.parse(
      readFileSync(
        prepareEngineRuntimeConfig({ ...input, networkProxySettings: settings }).configPath,
        'utf8'
      )
    )
  expect(read().requests).toEqual({ 'proxy-url': 'http://127.0.0.1:19877' })
  expect(read({ httpProxyUrl: 'http://127.0.0.1:19878' }).requests).toEqual({
    'proxy-url': 'http://127.0.0.1:19878'
  })
  expect(read(null)).not.toHaveProperty('requests')
  expect(() => read({ httpProxyUrl: 'unsupported://127.0.0.1' })).toThrow(
    'proxy configuration is invalid'
  )
  expect(
    JSON.parse(readFileSync(prepareEngineRuntimeConfig(options()).configPath, 'utf8'))
  ).not.toHaveProperty('requests')
})
