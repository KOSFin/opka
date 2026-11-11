import { readyCodexPoolSelection, assertExpectedEngineAccount } from './engine-account-readiness'
import { claimCodexEngineProfile } from './codex-engine-profile-owner'
import { nativeCodexGatewayLaunch } from './codex-native-http-authentication'
import { readOrCreateNativeCodexGatewayCredential } from './native-codex-gateway-credential'
import { assertEngineWriterIdle } from './engine-writer-ownership'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { CodexPoolSelectionState } from './codex-pool-turn-session'
import { CodexEngineHttpListener } from './codex-engine-http-listener'
import type { CodexEngineSessions, NativeEngineLaunch } from './codex-engine-sessions'
import type { CodexEngineLifecycle } from './codex-engine-lifecycle'
import { createCodexEngineNativeSessionLifetime } from './codex-engine-native-session-lifetime'
import { CodexEngineGrantService } from './engine-grant-service'
import { CodexEngineMutations } from './codex-engine-mutation'
import { CodexEngineAdmission } from './codex-engine-admission'
import { readEngineGrantConnection, removeEngineGrantConnection } from './engine-grant-files'
import type { CodexEngineHostOptions } from './codex-engine-host-options'
import { CodexReplaySpoolBudget } from './codex-replay-spool'
export type { CodexEngineHostOptions } from './codex-engine-host-options'

/** One execution-host/profile owner; roster, policy and canonical agent status remain external. */
export class CodexEngineHost {
  private readonly lifecycle: CodexEngineLifecycle
  private readonly sessions: CodexEngineSessions
  private readonly releaseProfile: () => void
  private readonly profile: string
  private readonly admission: CodexEngineAdmission
  private readonly mutations: CodexEngineMutations
  private readonly front: CodexEngineHttpListener
  private nativeClientKey: string | undefined
  private grants: CodexEngineGrantService | undefined
  private stopping: Promise<void> | undefined
  constructor(private readonly options: CodexEngineHostOptions) {
    this.profile = resolve(options.directory)
    options.assertExclusiveProfile()
    const timeout = options.transitionTimeoutMs ?? 15000
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) {
      throw new Error('Routing transition deadline is invalid.')
    }
    this.admission = new CodexEngineAdmission(timeout)
    this.mutations = new CodexEngineMutations((operation) =>
      this.options.withAccountMutationLease(operation)
    )
    const lifetime = createCodexEngineNativeSessionLifetime(
      options,
      () => this.admission.accepting,
      (id) => this.selection(id),
      (id) => this.connection(id)
    )
    this.lifecycle = lifetime.lifecycle
    this.sessions = lifetime.sessions
    const replayBudget = options.replaySpoolDirectory
      ? new CodexReplaySpoolBudget(
          options.replaySpoolDirectory,
          512 * 1024 * 1024,
          options.assertExclusiveProfile
        )
      : undefined
    this.front = new CodexEngineHttpListener(
      options.maxRequestBytes,
      this.sessions.prepare,
      () => {
        void this.stop().catch(() => {})
      },
      () => this.getNativeClientKey(),
      replayBudget
    )
    this.releaseProfile = claimCodexEngineProfile(this.profile)
  }
  getNativeClientKey(): string {
    if (this.admission.closing) {
      throw new Error('Native routing is shutting down.')
    }
    const key = readOrCreateNativeCodexGatewayCredential(
      this.profile,
      this.options.assertExclusiveProfile
    )
    if (this.nativeClientKey && this.nativeClientKey !== key) {
      throw new Error('Native routing local credentials changed; restart requires review.')
    }
    return (this.nativeClientKey ??= key)
  }
  async prepareNativeLaunch(launch: NativeEngineLaunch) {
    if (this.admission.closing) {
      throw new Error('The routing host is shutting down.')
    }
    const selection = this.options.readSelectionState(launch.launchId)
    const automatic = selection.policy?.applyToNewWork && selection.policy.strategy !== 'manual'
    if (!automatic && !selection.manualAccountId) {
      return null
    }
    if (!automatic && selection.manualAccountId && !this.connection(selection.manualAccountId)) {
      throw new Error('Connect the selected account to routing before launching it.')
    }
    await this.transition(
      undefined,
      async (signal) => {
        const connections = this.connections()
        if (!connections.length) {
          throw new Error('No verified engine account is connected.')
        }
        if (connections.some((connection) => !this.lifecycle.ready(connection))) {
          await this.sessions.waitForSafeBoundary(signal)
          await this.mutations.run(signal, async () => {
            await this.lifecycle.stop()
            await this.lifecycle.start(this.connections(), signal, this.options.listAccounts())
          })
        }
        await this.front.listen()
      },
      false
    )
    if (this.admission.closing || !this.front.url) {
      throw new Error('Native routing is not ready.')
    }
    return nativeCodexGatewayLaunch(
      this.front.url,
      this.getNativeClientKey(),
      this.sessions.register(launch)
    )
  }
  async beginGrant(owner: string, target: { accountId: string; expectedRosterRevision: string }) {
    if (this.admission.closing) {
      throw new Error('The routing host is shutting down.')
    }
    this.grants ??= new CodexEngineGrantService({
      directory: this.options.directory,
      prepareEngine: (signal) =>
        this.transition(
          signal,
          async (inner) => {
            const asset = await this.lifecycle.provision(inner)
            return { ...asset, memoryMiB: this.options.memoryMiB }
          },
          false,
          false,
          120000
        ),
      readAccount: this.options.readAccount,
      assertEnrollmentIdle: this.options.assertEnrollmentIdle,
      assertExclusiveProfile: this.options.assertExclusiveProfile,
      networkProxySettings: this.options.networkProxySettings,
      runLogin: this.options.runLogin,
      withActivationLease: (expected, publish, signal) =>
        this.transition(signal, async (inner) =>
          this.mutations.run(inner, async () => {
            inner.throwIfAborted()
            assertExpectedEngineAccount(expected, this.options.readAccount(expected.id))
            await this.lifecycle.stop()
            inner.throwIfAborted()
            assertExpectedEngineAccount(expected, this.options.readAccount(expected.id))
            const descriptor = publish()
            await this.lifecycle.start(this.connections(), inner, this.options.listAccounts())
            return descriptor
          })
        )
    })
    return this.grants.begin(owner, target)
  }
  grant(owner: string, id: string) {
    return this.requireGrants().get(owner, id)
  }
  grantPhase(owner: string, id: string) {
    return this.requireGrants().phase(owner, id)
  }
  cancelGrant(owner: string, id: string) {
    return this.requireGrants().cancel(owner, id)
  }
  readConnection(id: string) {
    const connection = this.connection(id)
    return connection ? { ...connection, adopted: this.lifecycle.ready(connection) } : null
  }
  invalidateAccount(id: string): void {
    this.grants?.invalidateAccount(id)
  }
  async removeNativeAccount<T>(id: string, commitNativeRemoval: () => Promise<T>): Promise<T> {
    this.sessions.assertAccountUnused(id)
    return this.transition(
      undefined,
      async (signal) => {
        this.sessions.assertAccountUnused(id)
        await this.sessions.waitForIdleRequests(signal)
        return this.mutations.run(signal, async () => {
          signal.throwIfAborted()
          this.sessions.assertAccountUnused(id)
          this.invalidateAccount(id)
          const restart = this.lifecycle.running
          if (!restart) {
            assertEngineWriterIdle({
              directory: join(this.options.directory, 'runtime'),
              assertExclusive: this.options.assertExclusiveProfile
            })
          }
          await this.lifecycle.stop()
          signal.throwIfAborted()
          const result = await commitNativeRemoval()
          if (z.uuid().safeParse(id).success) {
            removeEngineGrantConnection(this.options.directory, id)
          }
          if (restart) {
            await this.lifecycle.start(this.connections(), signal, this.options.listAccounts())
          }
          return result
        })
      },
      false
    )
  }
  async retireDeletedAccount(id: string, signal?: AbortSignal): Promise<void> {
    this.invalidateAccount(id)
    await this.transition(signal, (inner) =>
      this.mutations.run(inner, async () => {
        inner.throwIfAborted()
        if (this.options.readAccount(id)) {
          throw new Error('The host roster still owns this account.')
        }
        await this.lifecycle.stop()
        inner.throwIfAborted()
        if (this.options.readAccount(id)) {
          throw new Error('The account was recreated during retirement.')
        }
        removeEngineGrantConnection(this.options.directory, id)
        await this.lifecycle.start(this.connections(), inner, this.options.listAccounts())
      })
    )
  }
  beginShutdown(): Promise<void> | null {
    this.admission.beginShutdown()
    this.sessions.suspend()
    this.front.cancelRequests()
    return this.grants?.stop() ?? null
  }
  stop(): Promise<void> {
    this.stopping ??= this.finishShutdown().catch((error) => {
      this.stopping = undefined
      throw error
    })
    return this.stopping
  }
  private async finishShutdown(): Promise<void> {
    await this.beginShutdown()
    await this.transition(
      undefined,
      async () => {
        await this.lifecycle.stop()
        this.sessions.engineExited()
        await this.sessions.revokeAll()
        await this.front.close()
        this.releaseProfile()
      },
      false,
      true
    )
  }
  private connection(id: string) {
    try {
      const account = this.options.readAccount(id)
      return account?.id === id ? readEngineGrantConnection(this.options.directory, account) : null
    } catch {
      return null
    }
  }
  private connections() {
    return this.options.listAccounts().flatMap((account) => {
      const connection = this.connection(account.id)
      return connection ? [connection] : []
    })
  }
  private selection(launchId: string): CodexPoolSelectionState {
    return readyCodexPoolSelection(this.options.readSelectionState(launchId), (id) => {
      const connection = this.connection(id)
      return Boolean(connection && this.lifecycle.ready(connection))
    })
  }
  private requireGrants() {
    if (!this.grants) {
      throw new Error('Routing consent has not started on this host.')
    }
    return this.grants
  }
  private transition<T>(
    parent: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
    drain = true,
    allowClosing = false,
    timeoutMs?: number
  ): Promise<T> {
    return this.admission.run(
      parent,
      async (signal) => {
        this.options.assertExclusiveProfile()
        if (drain) {
          await this.sessions.waitForSafeBoundary(signal)
        }
        signal.throwIfAborted()
        return operation(signal)
      },
      allowClosing,
      timeoutMs
    )
  }
}
