import { join } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import type { NetworkProxySettings } from '../../shared/network-proxy'
import { ensurePinnedEngineAsset } from './engine-asset-cache'
import { startEngineRuntime, type EngineRuntimeHandle } from './engine-runtime'
import { readEngineModelPrefixes } from './engine-model-adoption'
import type { EngineGrantDescriptor, EngineGrantAccount } from './engine-grant-files'
import { reconcileEngineAuthDirectory } from './engine-auth-reconciliation'
import { assertEngineWriterIdle } from './engine-writer-ownership'
import { supportsCodexEngineGateway } from './codex-engine-capability'

export type CodexEngineLifecycleOptions = {
  directory: string
  cacheDirectory: string
  memoryMiB: number
  maxRequestBytes: number
  networkProxySettings?: NetworkProxySettings | null
  /** Execution-host profile ownership excludes another live or unverifiable controller. */
  assertExclusiveProfile: () => void
  ensureAsset?: typeof ensurePinnedEngineAsset
  startRuntime?: typeof startEngineRuntime
  readPrefixes?: typeof readEngineModelPrefixes
  onWriterIdleProven?: () => void
}
async function unusedPort(): Promise<number> {
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const address = reservation.address()
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve()))
  )
  if (!address || typeof address === 'string') {
    throw new Error('Engine loopback port is unavailable.')
  }
  return address.port
}
export class CodexEngineLifecycle {
  private asset: Awaited<ReturnType<typeof ensurePinnedEngineAsset>> | undefined
  private runtime: EngineRuntimeHandle | undefined
  private readonly adopted = new Map<string, number>()
  constructor(private readonly options: CodexEngineLifecycleOptions) {}
  get running(): boolean {
    return this.runtime !== undefined
  }
  async provision(signal: AbortSignal) {
    if (!supportsCodexEngineGateway() && !this.options.startRuntime) {
      throw new Error('Engine routing is unavailable on this platform.')
    }
    this.options.assertExclusiveProfile()
    if (!this.asset) {
      assertEngineWriterIdle({
        directory: join(this.options.directory, 'runtime'),
        assertExclusive: this.options.assertExclusiveProfile
      })
      this.options.onWriterIdleProven?.()
      this.asset = await (this.options.ensureAsset ?? ensurePinnedEngineAsset)({
        cacheDirectory: this.options.cacheDirectory,
        signal,
        assertExclusiveInstallLease: this.options.assertExclusiveProfile,
        assertCanReplaceInstalledBinary: () => {
          if (this.runtime && this.runtime.verdict !== 'exited') {
            throw new Error('An engine still owns this binary.')
          }
        }
      })
    }
    signal.throwIfAborted()
    return this.asset
  }
  async start(
    connections: EngineGrantDescriptor[],
    signal: AbortSignal,
    accounts: EngineGrantAccount[]
  ): Promise<void> {
    signal.throwIfAborted()
    if (!connections.length) {
      return
    }
    if (this.runtime) {
      if (connections.every((c) => this.ready(c))) {
        return
      }
      await this.stop()
    }
    reconcileEngineAuthDirectory({
      directory: this.options.directory,
      accounts,
      assertExclusiveProfile: this.options.assertExclusiveProfile
    })
    const asset = await this.provision(signal)
    const first = connections[0]
    this.options.assertExclusiveProfile()
    const runtime = await (this.options.startRuntime ?? startEngineRuntime)({
      ...asset,
      directory: join(this.options.directory, 'runtime'),
      port: await unusedPort(),
      memoryMiB: this.options.memoryMiB,
      maxRequestBytes: this.options.maxRequestBytes,
      networkProxySettings: this.options.networkProxySettings,
      auth: {
        kind: 'ready-engine-auth',
        directory: join(this.options.directory, 'active-auth'),
        credentialId: first.credentialId,
        prefix: first.prefix
      },
      assertExclusiveRuntimeDirectory: this.options.assertExclusiveProfile,
      onStarted: (runtime) => {
        this.runtime = runtime
        this.adopted.clear()
      }
    })
    this.runtime = runtime
    // The model registry must contain every account prefix before any native session is admitted.
    for (let attempt = 0; attempt < 20; attempt++) {
      signal.throwIfAborted()
      if (runtime.verdict !== 'live') {
        throw new Error('Engine ownership is unavailable.')
      }
      const prefixes = await (this.options.readPrefixes ?? readEngineModelPrefixes)(runtime, signal)
      if (connections.every((c) => prefixes.has(c.prefix))) {
        connections.forEach((c) => this.adopted.set(c.accountId, c.authenticatedAt))
        return
      }
      await delay(250, undefined, { signal })
    }
    throw new Error('The engine has not adopted every account connection.')
  }
  ready(connection: EngineGrantDescriptor): boolean {
    return (
      this.runtime?.verdict === 'live' &&
      this.adopted.get(connection.accountId) === connection.authenticatedAt
    )
  }
  route(connection: EngineGrantDescriptor) {
    if (!this.ready(connection) || !this.runtime) {
      throw new Error('The engine account connection is not adopted.')
    }
    return { port: this.runtime.port, clientKey: this.runtime.clientKey, prefix: connection.prefix }
  }
  async stop(): Promise<void> {
    this.adopted.clear()
    const runtime = this.runtime
    if (!runtime) {
      assertEngineWriterIdle({
        directory: join(this.options.directory, 'runtime'),
        assertExclusive: this.options.assertExclusiveProfile
      })
      return
    }
    const result = await runtime.stop()
    if (result.root !== 'exited' || result.tree === 'live' || result.tree === 'unverifiable') {
      throw new Error('Engine writer exit could not be verified.')
    }
    this.runtime = undefined
    assertEngineWriterIdle({
      directory: join(this.options.directory, 'runtime'),
      assertExclusive: this.options.assertExclusiveProfile
    })
  }
  get verdict() {
    return this.runtime?.verdict ?? 'exited'
  }
}
