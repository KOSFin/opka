import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { isAbsolute } from 'node:path'
import { buildConfiguredProxyEnv, type NetworkProxySettings } from '../../shared/network-proxy'
import { engineLoopbackReady } from './engine-loopback-readiness'
import { reserveEngineWriter } from './engine-writer-ownership'
import { spawnManagedProviderProcess } from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import {
  prepareEngineRuntimeConfig,
  type EngineRuntimeConfigOptions
} from './engine-runtime-config'

export type EngineRuntimeOptions = EngineRuntimeConfigOptions & {
  binaryPath: string
  expectedSha256: string
  /** Go GC target only; the owning host must also enforce its process/resource budget. */
  memoryMiB: number
  startupTimeoutMs?: number
  networkProxySettings?: NetworkProxySettings | null
  onStarted?: (runtime: EngineRuntimeHandle) => void
}

export type EngineRuntimeHandle = {
  host: '127.0.0.1'
  port: number
  clientKey: string
  binarySha256: string
  configPath: string
  authReference: EngineRuntimeConfigOptions['auth']
  stop: () => ReturnType<ReturnType<typeof spawnManagedProviderProcess>['close']>
  forceStop: () => ReturnType<ReturnType<typeof spawnManagedProviderProcess>['terminateTree']>
  readonly verdict: 'live' | 'unverifiable' | 'exited'
}

export function createEngineRuntimeLaunch(
  files: Pick<ReturnType<typeof prepareEngineRuntimeConfig>, 'directory' | 'configPath'>,
  binaryPath: string,
  memoryMiB: number,
  networkProxySettings?: NetworkProxySettings | null
): ProviderProcessLaunch {
  if (
    !isAbsolute(binaryPath) ||
    !Number.isSafeInteger(memoryMiB) ||
    memoryMiB < 32 ||
    memoryMiB > 512
  ) {
    throw new Error('Pinned engine path or Go memory budget is invalid')
  }
  const env: Record<string, string> = {
    HOME: files.directory,
    USERPROFILE: files.directory,
    TMPDIR: files.directory,
    TMP: files.directory,
    TEMP: files.directory,
    ORCA_BACKGROUND_LAUNCH: '1',
    GOMAXPROCS: '1',
    GOMEMLIMIT: `${memoryMiB}MiB`
  }
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'LANG']) {
    const value = process.env[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  if (networkProxySettings !== undefined) {
    Object.assign(env, buildConfiguredProxyEnv(networkProxySettings))
  } else {
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'no_proxy'
    ]) {
      const value = process.env[key]
      if (value !== undefined) {
        env[key] = value
      }
    }
  }
  return {
    command: binaryPath,
    args: ['-config', files.configPath, '-local-model'],
    cwd: files.directory,
    env
  }
}

export async function verifyEngineBinary(path: string, expected: string): Promise<string> {
  if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error('An absolute engine binary and pinned SHA256 are required')
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  const actual = hash.digest('hex')
  if (actual !== expected) {
    throw new Error('Engine binary does not match its pinned SHA256')
  }
  return actual
}

/** Internal transport only: the host controller must reject WS upgrades and own admission/policy. */
export async function startEngineRuntime(options: EngineRuntimeOptions) {
  const timeout = options.startupTimeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) {
    throw new Error('Engine startup deadline is invalid')
  }
  const authReference = Object.freeze({ ...options.auth })
  const binarySha256 = await verifyEngineBinary(options.binaryPath, options.expectedSha256)
  if (process.platform === 'win32') {
    throw new Error(
      'Native account routing requires verified engine writer ownership on this platform.'
    )
  }
  const ownership = reserveEngineWriter({
    directory: options.directory,
    assertExclusive: options.assertExclusiveRuntimeDirectory
  })
  let files: ReturnType<typeof prepareEngineRuntimeConfig>
  let launch: ProviderProcessLaunch
  try {
    files = prepareEngineRuntimeConfig({ ...options, auth: authReference })
    launch = createEngineRuntimeLaunch(
      files,
      options.binaryPath,
      options.memoryMiB,
      options.networkProxySettings
    )
  } catch (error) {
    ownership.cancelBeforeSpawn()
    throw error
  }
  let groupRecorded = false
  let ownershipError: unknown
  const managed = spawnManagedProviderProcess(launch, {
    site: 'codex-routing-engine',
    inheritedEnv: {},
    discardOutput: true,
    onGroupProven: (group) => {
      try {
        ownership.recordGroup(group)
        groupRecorded = true
      } catch (error) {
        ownershipError = error
      }
    }
  })
  let released = false
  const stop = async () => {
    const result = await managed.close()
    if (!released) {
      ownership.release(result)
      released = true
    }
    return result
  }
  const deadline = Date.now() + timeout
  const runtime: EngineRuntimeHandle = {
    host: files.host,
    port: files.port,
    clientKey: files.clientKey,
    binarySha256,
    configPath: files.configPath,
    authReference,
    stop,
    forceStop: () => managed.terminateTree(),
    get verdict() {
      return managed.rootVerdict
    }
  }
  try {
    options.onStarted?.(runtime)
    while (Date.now() < deadline && managed.rootVerdict !== 'exited') {
      if (ownershipError) {
        throw new Error('Engine writer ownership could not be recorded.')
      }
      try {
        const ready = await engineLoopbackReady(
          files.port,
          files.clientKey,
          Math.min(300, Math.max(1, deadline - Date.now()))
        )
        if (ready && managed.rootVerdict === 'live' && groupRecorded) {
          return runtime
        }
      } catch {
        // Readiness failures carry no response bodies or provider diagnostics into host logs.
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(40, Math.max(0, deadline - Date.now())))
      )
    }
    throw new Error('Pinned engine did not become ready before its startup deadline')
  } catch (error) {
    await stop()
    throw error
  }
}
