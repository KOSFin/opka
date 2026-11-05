import { randomUUID } from 'node:crypto'
import type { NativeClaudeRefreshSourceStatus } from '../../shared/native-claude-refresh-source'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { isSameClaudeLogin, removeClaudeAccountFolder } from './claude-account-folder'
import { ClaudeNativeIdentity, readBoundedClaudeProfileJson } from './claude-native-access'
import { prepareClaudeProfileDirectory } from './claude-profile-paths'
import { refreshClaudeNativeAccess } from './claude-native-refresh-authority'
import {
  runClaudeNativeSourceLogin,
  type ClaudeNativeCodeWriter
} from './claude-native-source-login'
import {
  ClaudeNativeSourceProfiles,
  ClaudeNativeSourceAttestation
} from './claude-native-source-profile'
import type { ClaudeAccountService } from './service'
import { assertSameNativeCliCommand } from '../../shared/native-cli-unwrapped-command'
import {
  resolveClaudeNativeQualifiedLaunch,
  assertClaudeNativeSourceOpen,
  assertClaudeNativeSignInIdle
} from './claude-native-qualified-launch'

export type ClaudeNativeRefreshSourceStatus = Omit<NativeClaudeRefreshSourceStatus, 'accountId'>
type Launch = { command: string; args: string[]; version: string }

/** Independent native login, same roster UUID; legacy/global refresh credentials are never adopted. */
export class ClaudeNativeRefreshSources {
  private readonly profiles: ClaudeNativeSourceProfiles
  private readonly pending = new Map<string, AbortController>()
  private readonly refreshing = new Set<AbortController>()
  private readonly operations = new Set<Promise<unknown>>()
  private closed = false
  constructor(
    private readonly options: {
      dataRoot: string
      assertExclusiveProfile: () => void
      userHome: string
      userConfigDir?: string
      accounts: Pick<ClaudeAccountService, 'listAccounts' | 'withNativeRoutingMutation'> &
        Partial<
          Pick<
            ClaudeAccountService,
            'setNativeRoutingRetirement' | 'setNativeUsagePreparationResolver'
          >
        >
      resolveLaunch: () => Promise<Launch>
      platformQualified?: () => boolean
      machineIdentity?: () => string | null
      login?: typeof runClaudeNativeSourceLogin
    }
  ) {
    this.profiles = new ClaudeNativeSourceProfiles(options)
  }
  private qualifiedPlatform() {
    return this.options.platformQualified?.() ?? ['linux', 'darwin'].includes(process.platform)
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    const tracked: Promise<T> = operation.finally(() => {
      this.operations.delete(tracked)
    })
    this.operations.add(tracked)
    return tracked
  }
  private launch(): Promise<Launch> {
    return resolveClaudeNativeQualifiedLaunch({
      assertExclusive: () => this.assertOwned(),
      resolve: this.options.resolveLaunch
    })
  }
  assertNativeCommand = (command: string) =>
    this.launch().then((launch) => {
      assertSameNativeCliCommand('claude', command, launch.command)
      this.assertOwned()
    })
  assertAccountOwned = (accountId: string) => {
    this.assertOwned()
    this.profiles.read(accountId)
  }
  accountIds = () => this.profiles.accountIds()
  async readyAccountIds(): Promise<ReadonlySet<string>> {
    const qualified = !this.closed && this.qualifiedPlatform() && (await this.launch())
    return qualified ? this.profiles.readyAccountIds(qualified.version) : new Set<string>()
  }
  assertOwned = () =>
    assertClaudeNativeSourceOpen(!this.closed, this.options.assertExclusiveProfile)

  assertWriterIdle = () => {
    this.assertOwned()
    assertClaudeNativeSignInIdle(this.pending.size)
    this.profiles.assertNoWriters()
    this.assertOwned()
  }

  async state(accountId: string): Promise<ClaudeNativeRefreshSourceStatus> {
    if (this.closed || !this.qualifiedPlatform()) {
      return { state: 'unsupported' }
    }
    if (this.pending.has(accountId)) {
      return { state: 'signing-in' }
    }
    const launch = await this.launch().catch(() => null)
    if (!launch) {
      return { state: 'unsupported' }
    }
    return this.profiles.state(accountId, launch.version)
  }
  retireFromOwnedMutation = (accountId: string) => {
    this.assertOwned()
    return this.profiles.retire(accountId)
  }
  usagePreparation = (accountId: string, signal?: AbortSignal) =>
    this.profiles.usagePreparation(accountId, async () => {
      this.assertOwned()
      assertClaudeNativeSignInIdle(this.pending.size)
      await this.refresh(accountId, signal)
      this.assertOwned()
    })
  cancelSignIn(accountId: string): void {
    this.pending.get(accountId)?.abort()
  }

  signIn(
    accountId: string,
    onLink?: (authorizationUrl: string) => void,
    onCodeReady?: (submit: ClaudeNativeCodeWriter | null) => void
  ): Promise<ClaudeNativeRefreshSourceStatus> {
    this.profiles.account(accountId)
    if (
      this.closed ||
      !this.qualifiedPlatform() ||
      this.pending.has(accountId) ||
      this.pending.size >= 128
    ) {
      return Promise.reject(new Error('Claude native source sign-in is unavailable.'))
    }
    const cancelled = new AbortController()
    this.pending.set(accountId, cancelled)
    const operation = this.options.accounts.withNativeRoutingMutation(async () => {
      this.profiles.assertNoWriters()
      const account = this.profiles.account(accountId)
      const machine = this.profiles.machine()
      const launch = await this.launch()
      if (cancelled.signal.aborted) {
        throw new Error('Claude native source capability is unavailable.')
      }
      const root = this.profiles.root(accountId)
      const namespace = join(root, 'claude-profiles')
      const generations = existsSync(namespace) ? readdirSync(namespace) : []
      const previous = existsSync(join(root, 'active-source.json'))
        ? this.profiles.read(accountId)
        : null
      if (generations.some((generation) => generation !== previous?.attestation.generation)) {
        throw new Error('An unfinished native source requires verified cleanup.')
      }
      const generation = randomUUID()
      const profile = this.profiles.profile(accountId, generation)
      const finish = prepareClaudeProfileDirectory(
        root,
        profile,
        this.options.userHome,
        this.options.userConfigDir
      )
      finish()
      const writerDirectory = join(dirname(profile.home), 'writer')
      let leaseActive = true
      const assertExclusive = () => {
        this.options.assertExclusiveProfile()
        if (!leaseActive) {
          throw new Error('Claude native source mutation lease ended.')
        }
        this.profiles.account(accountId)
        if (this.profiles.machine() !== machine) {
          throw new Error('Claude native source host changed.')
        }
      }
      try {
        await (this.options.login ?? runClaudeNativeSourceLogin)({
          home: profile.home,
          nativeUserHome: this.options.userHome,
          writerDirectory,
          launch,
          assertExclusive,
          signal: cancelled.signal,
          onLink,
          onCodeReady
        })
        assertExclusive()
        const identity = ClaudeNativeIdentity.parse(
          readBoundedClaudeProfileJson(join(profile.home, '.claude.json')).oauthAccount
        )
        if (
          cancelled.signal.aborted ||
          !isSameClaudeLogin(account, {
            email: identity.emailAddress,
            organizationUuid: identity.organizationUuid
          })
        ) {
          throw new Error('The native sign-in does not match this saved Claude account.')
        }
        const attestation = ClaudeNativeSourceAttestation.parse({
          version: 1,
          accountId,
          generation,
          machine,
          identity,
          nativeVersion: launch.version,
          authenticatedAt: Date.now()
        })
        writeFileAtomically(join(root, 'active-source.json'), JSON.stringify(attestation), {
          mode: 0o600
        })
        if (previous) {
          await removeClaudeAccountFolder(
            root,
            previous.attestation.generation,
            this.options.assertExclusiveProfile
          )
        }
        return this.state(accountId)
      } catch {
        try {
          this.profiles.assertNoWriters()
          if (
            !existsSync(join(root, 'active-source.json')) ||
            this.profiles.read(accountId).attestation.generation !== generation
          ) {
            await removeClaudeAccountFolder(root, generation, this.options.assertExclusiveProfile)
          }
        } catch {
          /* Retain a source whose writer exit or ownership cannot be proven. */
        }
        throw new Error('Claude native source sign-in did not finish for this saved account.')
      } finally {
        leaseActive = false
      }
    })
    return this.track(
      operation
        .finally(() => {
          this.pending.delete(accountId)
        })
        .then(() => this.state(accountId))
    )
  }
  refresh(accountId: string, signal?: AbortSignal) {
    if (this.closed || this.refreshing.size >= 128) {
      return Promise.reject(new Error('Claude native source refresh is unavailable.'))
    }
    const controller = new AbortController()
    const stopped = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
    this.refreshing.add(controller)
    return this.track(
      this.options.accounts
        .withNativeRoutingMutation(async () => {
          if (stopped.aborted) {
            throw new Error('Claude native source refresh was stopped.')
          }
          if (!this.qualifiedPlatform()) {
            throw new Error('Claude native source capability is unavailable.')
          }
          this.profiles.assertNoWriters()
          const { attestation, profile } = this.profiles.read(accountId)
          const launch = await this.launch()
          let leaseActive = true
          try {
            return await refreshClaudeNativeAccess(
              {
                configDir: profile.home,
                nativeUserHome: this.options.userHome,
                writerDirectory: join(dirname(profile.home), 'writer'),
                expectedIdentity: attestation.identity,
                launch,
                qualifiedVersion: launch.version,
                assertExclusive: () => {
                  if (!leaseActive) {
                    throw new Error('Claude native source mutation lease ended.')
                  }
                  this.profiles.read(accountId)
                }
              },
              { signal: stopped }
            )
          } finally {
            leaseActive = false
          }
        })
        .finally(() => this.refreshing.delete(controller))
    )
  }
  async shutdown(): Promise<void> {
    this.closed = true
    for (const controller of this.pending.values()) {
      controller.abort()
    }
    for (const controller of this.refreshing) {
      controller.abort()
    }
    await Promise.allSettled(this.operations)
    await this.options.accounts.withNativeRoutingMutation(async () => {
      this.options.assertExclusiveProfile()
      this.profiles.assertNoWriters()
    })
  }
}
