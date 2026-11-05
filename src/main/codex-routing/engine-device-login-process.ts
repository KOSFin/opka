import { spawnManagedProviderProcess } from '../provider-process/managed-provider-process'
import type { CodexDeviceAuthorization } from '../../shared/account-device-sign-in'
import { createEngineRuntimeLaunch, verifyEngineBinary } from './engine-runtime'
import { prepareEngineRuntimeConfig } from './engine-runtime-config'
import { parseEngineDeviceAuthorization } from './engine-device-authorization'
import type { NetworkProxySettings } from '../../shared/network-proxy'
import { reserveEngineWriter } from './engine-writer-ownership'
import { supportsCodexEngineGateway } from './codex-engine-capability'

export type EngineDeviceLoginOptions = {
  binaryPath: string
  expectedSha256: string
  memoryMiB: number
  directory: string
  authDirectory: string
  signal: AbortSignal
  onPrompt: (prompt: CodexDeviceAuthorization) => void
  assertExclusiveRuntimeDirectory: () => void
  timeoutMs?: number
  networkProxySettings?: NetworkProxySettings | null
}
export type EngineDeviceLoginOutcome = {
  verdict: 'live' | 'unverifiable' | 'exited'
  closed: boolean
  cancelled: boolean
}

/** No raw provider output is retained outside the bounded transient prompt parser. */
export async function runEngineDeviceLogin(
  options: EngineDeviceLoginOptions
): Promise<EngineDeviceLoginOutcome> {
  const timeout = options.timeoutMs ?? 15 * 60_000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15 * 60_000) {
    throw new Error('Engine device login deadline is invalid.')
  }
  await verifyEngineBinary(options.binaryPath, options.expectedSha256)
  if (options.signal.aborted) {
    return { verdict: 'exited', closed: true, cancelled: true }
  }
  if (!supportsCodexEngineGateway()) {
    throw new Error('Engine device enrollment requires supported writer ownership proof.')
  }
  const ownership = reserveEngineWriter({
    directory: options.directory,
    assertExclusive: options.assertExclusiveRuntimeDirectory
  })
  let spawnAttempted = false
  let groupProven = false
  let proofFailed = false
  let onProofReady = (): void => {}
  const managed = (() => {
    try {
      const files = prepareEngineRuntimeConfig({
        directory: options.directory,
        port: 8317,
        auth: { kind: 'device-enrollment', directory: options.authDirectory },
        maxRequestBytes: 16384,
        assertExclusiveRuntimeDirectory: options.assertExclusiveRuntimeDirectory
      })
      const launch = createEngineRuntimeLaunch(
        files,
        options.binaryPath,
        options.memoryMiB,
        options.networkProxySettings
      )
      launch.args = [
        '--config',
        files.configPath,
        '--codex-device-login',
        '--no-browser',
        '--local-model'
      ]
      options.signal.throwIfAborted()
      spawnAttempted = true
      return spawnManagedProviderProcess(launch, {
        site: 'codex-routing-device-login',
        inheritedEnv: {},
        discardOutput: true,
        lifetime: 'one-shot',
        onGroupProven: (group) => {
          try {
            ownership.recordGroup(group)
            groupProven = true
          } catch {
            proofFailed = true
          }
          onProofReady()
        }
      })
    } catch (error) {
      if (!spawnAttempted) {
        ownership.cancelBeforeSpawn()
      }
      throw error
    }
  })()
  let closed = false
  let output = ''
  let published = false
  let cancelled = false
  let closeRequest: ReturnType<typeof managed.close> | undefined
  const onOutput = (chunk: Buffer): void => {
    if (published || options.signal.aborted) {
      return
    }
    output = `${output}${chunk.toString()}`.slice(-4000)
    if (!groupProven) {
      return
    }
    const prompt = parseEngineDeviceAuthorization(output)
    if (prompt) {
      published = true
      output = ''
      try {
        options.onPrompt(prompt)
      } catch {
        abort()
      }
    }
  }
  let resolveClosed = (): void => {}
  const closePromise = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  managed.child.once('close', () => {
    closed = true
    resolveClosed()
  })
  managed.child.stdout.on('data', onOutput)
  let resolveStopped = (): void => {}
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve
  })
  const abort = (): void => {
    cancelled = true
    closeRequest ??= managed.close()
    void closeRequest.catch(() => {}).finally(resolveStopped)
  }
  onProofReady = () => {
    if (proofFailed) {
      abort()
    } else {
      onOutput(Buffer.alloc(0))
    }
  }
  if (proofFailed) {
    abort()
  }
  options.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeout)
  if (options.signal.aborted) {
    abort()
  }
  try {
    await Promise.race([managed.exitPromise, stopped])
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      closePromise,
      new Promise<void>((resolve) => {
        closeTimer = setTimeout(resolve, 2500)
      })
    ]).finally(() => clearTimeout(closeTimer))
    let writerExited = false
    try {
      ownership.release(await (closeRequest ?? managed.close()))
      writerExited = true
    } catch {
      /* Unknown writers retain their durable receipt. */
    }
    return { verdict: managed.rootVerdict, closed: closed && writerExited, cancelled }
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
    managed.child.stdout.off('data', onOutput)
    output = ''
  }
}
