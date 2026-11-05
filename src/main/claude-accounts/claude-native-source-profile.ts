import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { readClaudeOAuthCredentials } from '../rate-limits/claude-oauth-credentials'
import type { NativeClaudeRefreshSourceStatus } from '../../shared/native-claude-refresh-source'
import { assertEngineWriterIdle } from '../codex-routing/engine-writer-ownership'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import { isSameClaudeLogin, removeClaudeAccountFolder } from './claude-account-folder'
import { ClaudeNativeIdentity, readBoundedClaudeProfileJson } from './claude-native-access'
import {
  assertClaudeProfileDescendant,
  claudeProfileMarkerPath,
  describeClaudeProfile,
  prepareClaudeProfileDirectory
} from './claude-profile-paths'
import { assertNoUnverifiableClaudeFacades } from './claude-native-facade-retirement'
import type { ClaudeAccountService } from './service'

export const ClaudeNativeSourceAttestation = z
  .object({
    version: z.literal(1),
    accountId: z.string().min(1).max(256),
    generation: z.uuid(),
    machine: z.string().length(64),
    identity: ClaudeNativeIdentity,
    authenticatedAt: z.number().finite().positive(),
    nativeVersion: z.string().max(40)
  })
  .strict()
export class ClaudeNativeSourceProfiles {
  constructor(
    private readonly options: {
      dataRoot: string
      assertExclusiveProfile: () => void
      userHome: string
      userConfigDir?: string
      accounts: Pick<ClaudeAccountService, 'listAccounts'>
      machineIdentity?: () => string | null
    }
  ) {}
  accountIds(): string[] {
    this.options.assertExclusiveProfile()
    return this.options.accounts.listAccounts().accounts.map((account) => account.id)
  }
  async readyAccountIds(nativeVersion: string): Promise<ReadonlySet<string>> {
    const states = await Promise.all(
      this.accountIds().map(async (accountId) => ({
        accountId,
        state: await this.state(accountId, nativeVersion)
      }))
    )
    this.options.assertExclusiveProfile()
    return new Set(
      states.filter((item) => item.state.state === 'ready').map((item) => item.accountId)
    )
  }
  account(accountId: string) {
    this.options.assertExclusiveProfile()
    if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) {
      throw new Error('Claude native source identity is unavailable.')
    }
    const account = this.options.accounts
      .listAccounts()
      .accounts.find((entry) => entry.id === accountId)
    if (!account || account.managedAuthRuntime === 'wsl') {
      throw new Error('Claude native source identity is unavailable.')
    }
    return account
  }
  root(accountId: string) {
    this.options.assertExclusiveProfile()
    if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) {
      throw new Error('Claude native source identity is unavailable.')
    }
    const root = join(this.options.dataRoot, 'claude-native-refresh-sources', accountId)
    assertClaudeProfileDescendant(this.options.dataRoot, root)
    return root
  }
  machine() {
    this.options.assertExclusiveProfile()
    const identity = (this.options.machineIdentity ?? profileStateAccessMachineIdentity)()
    if (!identity) {
      throw new Error('Claude native source execution host is unverifiable.')
    }
    return createHash('sha256').update(identity).digest('hex')
  }
  hasSource(accountId: string): boolean {
    this.account(accountId)
    const root = this.root(accountId),
      namespace = join(root, 'claude-profiles')
    return (
      existsSync(join(root, 'active-source.json')) ||
      (existsSync(namespace) && readdirSync(namespace).length > 0)
    )
  }
  profile(accountId: string, generation: string) {
    return describeClaudeProfile(this.root(accountId), generation, {
      executionHostId: 'local',
      runtime: 'host'
    })
  }
  assertNoWriters() {
    const root = join(this.options.dataRoot, 'claude-native-refresh-sources')
    if (!existsSync(root)) {
      return
    }
    const accounts = readdirSync(root)
    if (accounts.length > 128) {
      throw new Error('Claude native source inventory requires review.')
    }
    for (const accountId of accounts) {
      const profiles = join(this.root(accountId), 'claude-profiles')
      if (!existsSync(profiles)) {
        continue
      }
      const generations = readdirSync(profiles)
      if (generations.length > 2) {
        throw new Error('Claude native source inventory requires review.')
      }
      for (const generation of generations) {
        const profile = this.profile(accountId, z.uuid().parse(generation))
        prepareClaudeProfileDirectory(
          this.root(accountId),
          profile,
          this.options.userHome,
          this.options.userConfigDir
        )
        const directory = join(dirname(profile.home), 'writer')
        if (
          existsSync(join(directory, 'writer-owner.json')) ||
          existsSync(join(directory, 'writer-owner.json.next'))
        ) {
          assertEngineWriterIdle({
            directory,
            assertExclusive: () => {
              this.account(accountId)
            }
          })
        }
      }
    }
  }
  async state(
    accountId: string,
    nativeVersion: string
  ): Promise<Omit<NativeClaudeRefreshSourceStatus, 'accountId'>> {
    try {
      const { profile } = this.read(accountId)
      const generations = readdirSync(join(this.root(accountId), 'claude-profiles'))
      if (generations.length !== 1 || generations[0] !== profile.accountId) {
        return { state: 'unverifiable' }
      }
      const credentials = await readClaudeOAuthCredentials({
        credentialsFileConfigDir: profile.home,
        keychainConfigDir: profile.home,
        includeNativeAccess: true
      })
      this.options.assertExclusiveProfile()
      return {
        state:
          credentials.nativeAccess &&
          credentials.hasRefreshableCredentials &&
          !credentials.unavailable
            ? 'ready'
            : 'needs-sign-in',
        nativeVersion: nativeVersion
      }
    } catch {
      return {
        state:
          existsSync(join(this.root(accountId), 'active-source.json')) ||
          (existsSync(join(this.root(accountId), 'claude-profiles')) &&
            readdirSync(join(this.root(accountId), 'claude-profiles')).length > 0)
            ? 'unverifiable'
            : 'needs-sign-in'
      }
    }
  }
  async usagePreparation(
    accountId: string,
    refresh: () => Promise<void>
  ): Promise<ClaudeRuntimeAuthPreparation | undefined> {
    if (!this.hasSource(accountId)) {
      return undefined
    }
    try {
      await refresh()
      this.options.assertExclusiveProfile()
      const { profile } = this.read(accountId)
      return {
        configDir: profile.home,
        envPatch: { CLAUDE_CONFIG_DIR: profile.home },
        provenance: `profile:${accountId}`,
        runtime: 'host'
      }
    } catch {
      return {
        configDir: '',
        envPatch: {},
        provenance: `profile:${accountId}`,
        usageError:
          'The dedicated native Claude source is unavailable. Reconnect it before refreshing usage.'
      }
    }
  }
  async retire(accountId: string): Promise<void> {
    const account = this.account(accountId)
    assertNoUnverifiableClaudeFacades(this.options.dataRoot, account)
    this.assertNoWriters()
    const root = this.root(accountId)
    if (!existsSync(root)) {
      return
    }
    if (
      readdirSync(root).some((name) => name !== 'active-source.json' && name !== 'claude-profiles')
    ) {
      throw new Error('Claude native source contains unknown retained files.')
    }
    if (existsSync(join(root, 'active-source.json'))) {
      this.read(accountId)
    }
    const namespace = join(root, 'claude-profiles')
    for (const generation of existsSync(namespace) ? readdirSync(namespace) : []) {
      await removeClaudeAccountFolder(
        root,
        z.uuid().parse(generation),
        this.options.assertExclusiveProfile
      )
      this.options.assertExclusiveProfile()
    }
    this.options.assertExclusiveProfile()
    rmSync(root, { recursive: true, force: true })
  }
  read(accountId: string) {
    const account = this.account(accountId)
    const file = join(this.root(accountId), 'active-source.json')
    const stat = lstatSync(file)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4096 ||
      (process.platform !== 'win32' &&
        ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))
    ) {
      throw new Error('Claude native source attestation is unavailable.')
    }
    const attestation = ClaudeNativeSourceAttestation.parse(readBoundedClaudeProfileJson(file))
    if (
      attestation.accountId !== accountId ||
      attestation.machine !== this.machine() ||
      !isSameClaudeLogin(account, {
        email: attestation.identity.emailAddress,
        organizationUuid: attestation.identity.organizationUuid
      })
    ) {
      throw new Error('Claude native source identity changed.')
    }
    const profile = this.profile(accountId, attestation.generation)
    const marker = readBoundedClaudeProfileJson(claudeProfileMarkerPath(profile))
    if (
      !existsSync(profile.home) ||
      marker.version !== 1 ||
      marker.accountId !== attestation.generation ||
      marker.runtime !== 'host'
    ) {
      throw new Error('Claude native source profile ownership is unavailable.')
    }
    prepareClaudeProfileDirectory(
      this.root(accountId),
      profile,
      this.options.userHome,
      this.options.userConfigDir
    )
    const identity = ClaudeNativeIdentity.parse(
      readBoundedClaudeProfileJson(join(profile.home, '.claude.json')).oauthAccount
    )
    if (
      identity.accountUuid !== attestation.identity.accountUuid ||
      identity.organizationUuid !== attestation.identity.organizationUuid ||
      identity.emailAddress.toLowerCase() !== attestation.identity.emailAddress.toLowerCase()
    ) {
      throw new Error('Claude native source login no longer matches its attestation.')
    }
    return { attestation, profile }
  }
}
