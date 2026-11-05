import { join } from 'node:path'
import { writeFile, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AccountPoolPolicy } from '../../shared/account-pool-policy'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import { createEmptyRateLimitState } from '../../shared/rate-limit-state-factory'
import { AgentTransitionDetector } from '../agent-hooks/agent-transition-detector'
import { agentHookServer } from '../agent-hooks/server'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  configureRuntimeClaudeNativeSources,
  getRuntimeClaudeNativeSources,
  shutdownRuntimeClaudeNativeSources
} from '../runtime/runtime-claude-native-sources'
import { readClaudeNativeAccessSnapshot } from './claude-native-access'
import type { createOwnedClaudeNativePty } from './claude-native-owned-pty-test-fixture'
import { probeClaudeCliVersion } from '../claude/claude-hook-event-versions'

export async function createNativeClaudeWrapperTestHost(options: {
  root: string
  rotation?: AccountPoolPolicy['rotation']
  executable: string
  hookBridge: string
  readPty: () => Awaited<ReturnType<typeof createOwnedClaudeNativePty>> | undefined
}) {
  const identities = ['A', 'B', 'C'].map((id) => ({
    id,
    accountUuid: randomUUID(),
    organizationUuid: randomUUID(),
    emailAddress: `${id.toLowerCase()}@example.invalid`
  }))
  const rows = identities.map((entry) => ({
    id: entry.id,
    email: entry.emailAddress,
    managedAuthPath: join(options.root, 'legacy-roster', entry.id, '.credentials.json'),
    organizationUuid: entry.organizationUuid,
    authMethod: 'subscription-oauth' as const,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }))
  const policy: AccountPoolPolicy = {
    id: 'native-claude-pool',
    provider: 'claude',
    revision: 1,
    strategy: 'balanced',
    applyToNewWork: true,
    rotation: options.rotation ?? 'after-turn',
    unknownQuota: 'allow',
    allowReserve: false,
    members: rows.map((row) => ({
      accountId: row.id,
      priority: 1,
      weight: 1,
      maxConcurrent: 1,
      state: 'enabled',
      role: 'primary'
    }))
  }
  const settings = createGlobalSettingsFixture({
    accountPools: [policy],
    activeClaudeManagedAccountId: 'A',
    claudeManagedAccounts: rows
  })
  const db = new OrchestrationDb(':memory:')
  const transitions = new AgentTransitionDetector({
    resolveTabWorktreeId: () => 'synthetic-owned-native-folder',
    subscribeToPtyExit: (_id, listener) => options.readPty()?.subscribeExit(listener) ?? (() => {}),
    now: Date.now
  })
  const detach = transitions.attach(agentHookServer)
  const host = {
    requireStore: () => ({ getSettings: () => settings }),
    getClientSettings: () => settings,
    getAccountsSnapshot: () => ({
      claude: { accounts: rows, activeAccountId: 'A' },
      codex: { accounts: [], activeAccountId: null },
      rateLimits: createEmptyRateLimitState()
    }),
    getOrchestrationDb: () => db,
    getCommitMessageAgentEnvironmentResolvers: () => ({}),
    agentTransitions: transitions,
    getOrchestrationDispatchAuthority: () => null,
    resolveTerminalPane: () => {
      const pty = options.readPty()
      if (!pty) {
        throw new Error('Physical native terminal is not attached.')
      }
      return pty.resolvePane()
    },
    subscribeToPtyExit: (_id: string, listener: () => void) =>
      options.readPty()?.subscribeExit(listener) ?? (() => {}),
    getPtyExecutionHostMetadata: () => ({
      incarnationId: options.readPty()?.incarnationId,
      executionHostId: 'local',
      hostPlatform: process.platform
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only declared routing services are called; settings/account login are synthetic, physical PID/incarnation come from the real TerminalHost.
  const runtime = host as unknown as OrcaRuntimeService
  let mutation: Promise<unknown> = Promise.resolve()
  const accounts = {
    listAccounts: () => ({ accounts: rows, activeAccountId: 'A', systemDefaultMayBeCopied: false }),
    withNativeRoutingMutation<T>(operation: () => Promise<T>) {
      const result = mutation.then(operation, operation)
      mutation = result.catch(() => {})
      return result
    }
  }
  const homes = new Map<string, string>()
  let signingAccount: string | undefined
  configureRuntimeClaudeNativeSources(runtime, {
    dataRoot: join(options.root, 'data'),
    userHome: options.root,
    accounts,
    assertExclusiveProfile() {},
    machineIdentity: () => 'isolated-native-wrapper-host',
    platformQualified: () => true,
    resolveLaunch: async () => ({
      command: options.executable,
      args: [],
      version: (await probeClaudeCliVersion(options.executable)) ?? 'unknown'
    }),
    resolveHookLaunch: () => ({ command: process.execPath, args: [options.hookBridge] }),
    login: async ({ home }) => {
      const accountId = signingAccount
      const identity = identities.find((entry) => entry.id === accountId)
      if (!identity) {
        throw new Error('Unknown synthetic account.')
      }
      const { accountUuid, organizationUuid, emailAddress } = identity
      await writeFile(
        join(home, '.claude.json'),
        JSON.stringify({ oauthAccount: { accountUuid, organizationUuid, emailAddress } }),
        { mode: 0o600 }
      )
      await writeFile(
        join(home, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: `sk-ant-oat01-synthetic-wrapper-${identity.id}`,
            refreshToken: `synthetic-authority-only-${identity.id}`,
            expiresAt: Date.now() + 3600000,
            scopes: ['user:inference', 'user:profile']
          }
        }),
        { mode: 0o600 }
      )
      homes.set(identity.id, home)
    }
  })
  const sources = getRuntimeClaudeNativeSources(runtime)
  if (!sources) {
    throw new Error('Native source actor missing.')
  }
  for (const row of rows) {
    signingAccount = row.id
    await sources.signIn(row.id)
  }
  signingAccount = undefined
  vi.spyOn(sources, 'refresh').mockImplementation((id, signal) =>
    accounts.withNativeRoutingMutation(async () => {
      if (signal?.aborted) {
        throw new Error('Synthetic source cancelled.')
      }
      sources.assertAccountOwned(id)
      const home = homes.get(id),
        identity = identities.find((entry) => entry.id === id)
      if (!home || !identity) {
        throw new Error('Unknown source.')
      }
      const access = await readClaudeNativeAccessSnapshot(home, identity)
      if (!access) {
        throw new Error('Synthetic source access missing.')
      }
      sources.assertAccountOwned(id)
      return access
    })
  )
  return {
    runtime,
    identities,
    policy,
    db,
    sourceTokensRemainPrivate: async () => {
      for (const home of homes.values()) {
        if (!(await readFile(join(home, '.credentials.json'), 'utf8')).includes('refreshToken')) {
          return false
        }
      }
      return true
    },
    dispose: async () => {
      detach()
      await shutdownRuntimeClaudeNativeSources(runtime)
      db.close()
    }
  }
}
