import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { AccountDeviceSignIns } from '../runtime/account-device-sign-in'
import type { AccountDeviceSignIn } from '../../shared/account-device-sign-in'
import { ensurePrivateEngineDirectory } from './engine-runtime-config'
import { runEngineDeviceLogin } from './engine-device-login-process'
import type { NetworkProxySettings } from '../../shared/network-proxy'
import { assertEngineWriterIdle } from './engine-writer-ownership'
import { recoverEngineEnrollmentStages } from './engine-enrollment-recovery'
import {
  publishEngineGrant,
  readEngineGrantConnection,
  readStagedEngineGrant,
  type EngineGrantAccount,
  type EngineGrantDescriptor
} from './engine-grant-files'

type Attempt = {
  owner: string
  id: string
  account: EngineGrantAccount
  error?: string
  phase: 'consent' | 'activation'
}
type EngineGrantBinary = { binaryPath: string; expectedSha256: string; memoryMiB: number }
export type EngineGrantServiceOptions = {
  directory: string
  readAccount: (id: string) => EngineGrantAccount | null
  /** Holds the existing host account mutation lease, checks revision, and excludes the old refresh writer. */
  withActivationLease: (
    expected: EngineGrantAccount,
    publish: () => EngineGrantDescriptor,
    signal: AbortSignal
  ) => Promise<EngineGrantDescriptor>
  /** Must prove a crashed previous enrollment process exited before reusing or removing its fixed stage. */
  assertEnrollmentIdle: (accountId: string) => void
  assertExclusiveProfile: () => void
  runLogin?: typeof runEngineDeviceLogin
  networkProxySettings?: NetworkProxySettings | null
} & (
  | { engine: EngineGrantBinary; prepareEngine?: never }
  | { engine?: never; prepareEngine: (signal: AbortSignal) => Promise<EngineGrantBinary> }
)

/** Adds an engine connection to an existing host roster entry; never creates or imports an account. */
export class CodexEngineGrantService {
  private attempt: Attempt | null = null
  private readonly signIns: AccountDeviceSignIns
  constructor(private readonly options: EngineGrantServiceOptions) {
    ensurePrivateEngineDirectory(options.directory)
    ensurePrivateEngineDirectory(join(options.directory, 'active-auth'))
    ensurePrivateEngineDirectory(join(options.directory, 'connections'))
    ensurePrivateEngineDirectory(join(options.directory, 'staging'))
    this.signIns = new AccountDeviceSignIns(async (onPrompt, signal) => {
      const attempt = this.attempt
      if (!attempt) {
        throw new Error('Engine enrollment context is unavailable.')
      }
      const stage = join(options.directory, 'staging', attempt.account.id)
      let exited = false
      try {
        recoverEngineEnrollmentStages({
          directory: join(options.directory, 'staging'),
          assertExclusiveProfile: options.assertExclusiveProfile,
          assertEnrollmentIdle: options.assertEnrollmentIdle
        })
        const engine = options.engine ?? (await options.prepareEngine(signal))
        signal.throwIfAborted()
        options.assertEnrollmentIdle(attempt.account.id)
        if (!this.current(attempt.account) || signal.aborted) {
          throw new Error('Account changed.')
        }
        if (existsSync(stage)) {
          ensurePrivateEngineDirectory(stage)
          assertEngineWriterIdle({
            directory: join(stage, 'runtime'),
            assertExclusive: options.assertExclusiveProfile
          })
          rmSync(stage, { recursive: true })
        }
        ensurePrivateEngineDirectory(stage)
        const authDirectory = join(stage, 'auth')
        ensurePrivateEngineDirectory(authDirectory)
        const outcome = await (options.runLogin ?? runEngineDeviceLogin)({
          ...engine,
          directory: join(stage, 'runtime'),
          authDirectory,
          signal,
          onPrompt,
          networkProxySettings: options.networkProxySettings,
          assertExclusiveRuntimeDirectory: options.assertExclusiveProfile
        })
        exited = outcome.closed && outcome.verdict === 'exited'
        if (!exited) {
          throw new Error('Engine enrollment exit could not be verified.')
        }
        if (outcome.cancelled || signal.aborted || !this.current(attempt.account)) {
          throw new Error('Account changed.')
        }
        const contents = readStagedEngineGrant(authDirectory, attempt.account)
        attempt.phase = 'activation'
        let published = false
        await options.withActivationLease(
          attempt.account,
          () => {
            if (published) {
              throw new Error('Engine grant publication was already completed.')
            }
            if (signal.aborted || !this.current(attempt.account)) {
              throw new Error('Account changed.')
            }
            const descriptor = publishEngineGrant(options.directory, attempt.account, contents)
            published = true
            return descriptor
          },
          signal
        )
        if (!published) {
          throw new Error('Engine grant publication was not completed.')
        }
      } catch {
        attempt.error =
          'Routing sign-in could not be verified. Check the selected account and retry.'
        throw new Error(attempt.error)
      } finally {
        if (exited && existsSync(stage)) {
          rmSync(stage, { recursive: true, force: true })
        }
      }
    })
  }

  begin(
    owner: string,
    target: { accountId: string; expectedRosterRevision: string }
  ): AccountDeviceSignIn {
    if (!z.uuid().safeParse(target.accountId).success) {
      throw new Error('Select an existing Codex account.')
    }
    let account: EngineGrantAccount | null
    try {
      account = this.options.readAccount(target.accountId)
    } catch {
      throw new Error('The selected account could not be read on this host.')
    }
    if (
      !account ||
      account.id !== target.accountId ||
      !account.providerAccountId?.trim() ||
      !account.rosterRevision ||
      account.rosterRevision.length > 512 ||
      account.providerAccountId.length > 512 ||
      account.rosterRevision !== target.expectedRosterRevision
    ) {
      throw new Error('The selected account changed or has no confirmed provider identity.')
    }
    const previous = this.attempt
    const state = this.signIns.begin(owner)
    if (previous && previous.id === state.id) {
      if (
        previous.account.id !== account.id ||
        previous.account.rosterRevision !== account.rosterRevision ||
        previous.account.providerAccountId !== account.providerAccountId
      ) {
        this.signIns.cancel(owner, state.id)
        throw new Error('The previous account sign-in is closing. Start a new sign-in shortly.')
      }
      return this.get(owner, state.id)
    }
    this.attempt = { owner, id: state.id, account: { ...account }, phase: 'consent' }
    return state
  }

  get(owner: string, id: string): AccountDeviceSignIn {
    let state = this.signIns.get(owner, id)
    const attempt = this.attempt
    if (
      attempt?.id === id &&
      (state.status === 'starting' || state.status === 'waiting') &&
      !this.current(attempt.account)
    ) {
      state = this.signIns.cancel(owner, id)
      return { ...state, error: 'The selected account changed. Start a new routing sign-in.' }
    }
    if (
      attempt?.phase === 'activation' &&
      (state.status === 'starting' || state.status === 'waiting')
    ) {
      return {
        id: state.id,
        provider: state.provider,
        expiresAt: state.expiresAt,
        status: 'starting'
      }
    }
    return state.status === 'failed' && attempt?.error ? { ...state, error: attempt.error } : state
  }
  phase(owner: string, id: string): 'consent' | 'activation' {
    this.signIns.get(owner, id)
    return this.attempt?.phase ?? 'consent'
  }
  cancel(owner: string, id: string): AccountDeviceSignIn {
    return this.signIns.cancel(owner, id)
  }
  stop(): Promise<void> | null {
    return this.signIns.stop()
  }
  readConnection(accountId: string): EngineGrantDescriptor | null {
    if (!z.uuid().safeParse(accountId).success) {
      return null
    }
    try {
      const account = this.options.readAccount(accountId)
      return account?.id === accountId
        ? readEngineGrantConnection(this.options.directory, account)
        : null
    } catch {
      return null
    }
  }
  readyAuthReference(accountId: string) {
    const connection = this.readConnection(accountId)
    if (!connection) {
      throw new Error('This account has no verified engine connection.')
    }
    return {
      kind: 'ready-engine-auth' as const,
      directory: join(this.options.directory, 'active-auth'),
      credentialId: connection.credentialId,
      prefix: connection.prefix
    }
  }
  invalidateAccount(accountId: string): void {
    const attempt = this.attempt
    if (attempt?.account.id === accountId) {
      this.signIns.cancel(attempt.owner, attempt.id)
    }
  }
  private current(expected: EngineGrantAccount): boolean {
    try {
      const current = this.options.readAccount(expected.id)
      return (
        current?.id === expected.id &&
        current.providerAccountId === expected.providerAccountId &&
        current.rosterRevision === expected.rosterRevision
      )
    } catch {
      return false
    }
  }
}
