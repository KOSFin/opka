import type { OrcaRuntimeService } from './orca-runtime'
import type {
  NativeCliAccountLaunch,
  NativeCliAccountLaunchRequest
} from '../../shared/native-cli-account-launch'
import { nativeCliExecutionMode } from './native-cli-execution-mode'
import {
  NATIVE_CLI_ACCOUNT_PIN_ENV,
  NATIVE_CLI_INITIAL_ASSIGNMENT_ENV,
  NATIVE_CODEX_ROUTING_KEY_ENV
} from '../../shared/native-cli-account-launch'
import { getDefaultAccountPool } from './runtime-account-pool-policy'
import { accountPoolCandidates } from './account-pool-candidates'
import { preparePinnedClaudeAccountLaunch } from '../claude-accounts/pinned-account-launch'
import { CLAUDE_AUTH_ENV_VARS } from '../claude-accounts/environment'
import { WORKER_CLAUDE_ACCOUNT_ENV } from '../claude-accounts/worker-account-launch'
import { WORKER_CODEX_ACCOUNT_ENV } from '../codex-accounts/worker-account-home'
import { nativeCodexAuthEnvToDelete } from '../codex/native-cli-auth-environment'
import {
  prepareNativeCodexRoutingLaunch,
  type NativeCodexRoutingRuntime
} from './native-codex-routing-launch'
import { prepareNativeClaudeRoutingLaunch } from './native-claude-routing-launch'
import { releaseNativeClaudeRoutingOwner } from './native-claude-routing-ownership'
import { revokeNativeCodexRoutingLaunch } from './native-codex-routing-ownership'

type Runtime = NativeCodexRoutingRuntime &
  Pick<
    OrcaRuntimeService,
    | 'requireStore'
    | 'getAccountsSnapshot'
    | 'getOrchestrationDb'
    | 'getWorkerCodexAccountEnv'
    | 'getCommitMessageAgentEnvironmentResolvers'
    | 'getOrchestrationDispatchAuthority'
  >

const workerMarkers = [
  NATIVE_CLI_INITIAL_ASSIGNMENT_ENV,
  WORKER_CODEX_ACCOUNT_ENV,
  WORKER_CLAUDE_ACCOUNT_ENV,
  NATIVE_CLI_ACCOUNT_PIN_ENV,
  NATIVE_CODEX_ROUTING_KEY_ENV
]
const ownerKey = (launchId: string) => `native-cli:${launchId}`

export async function prepareNativeCliAccountLaunch(
  runtime: Runtime,
  params: NativeCliAccountLaunchRequest,
  context: { pendingTerminal?: boolean; pendingStdio?: boolean } = {}
): Promise<NativeCliAccountLaunch> {
  const { provider, launchId } = params
  if (provider === 'claude' && params.stdio && !context.pendingStdio) {
    return {
      env: {},
      envToDelete: [],
      launchId,
      accountId: null,
      poolId: null,
      policyRevision: null,
      executionMode: 'host-stdio'
    }
  }
  const executionMode = nativeCliExecutionMode(runtime, params)
  if (executionMode === 'host-pty') {
    return {
      env: {},
      envToDelete: [],
      launchId,
      accountId: null,
      poolId: null,
      policyRevision: null,
      executionMode
    }
  }
  const policy = params.accountId ? undefined : getDefaultAccountPool(runtime, provider)
  const pool = policy?.strategy !== 'manual' ? policy : undefined
  const routed = await prepareNativeCodexRoutingLaunch(runtime, params, pool)
  if (routed) {
    return routed
  }
  const claudeRouted = await prepareNativeClaudeRoutingLaunch(
    runtime,
    params,
    context.pendingTerminal || context.pendingStdio
  )
  if (claudeRouted) {
    return claudeRouted
  }
  const db = pool ? runtime.getOrchestrationDb() : undefined
  const assignment =
    pool && db
      ? db.acquireAccountPoolAssignment({
          ownerKey: ownerKey(launchId),
          policy: pool,
          candidates: accountPoolCandidates(runtime.getAccountsSnapshot()).filter(
            (c) => c.provider === provider
          )
        })
      : undefined
  const accountId = params.accountId ?? assignment?.accountId
  try {
    let env: Record<string, string>
    const envToDelete = [...workerMarkers]
    if (accountId) {
      if (provider === 'codex') {
        env = { CODEX_HOME: runtime.getWorkerCodexAccountEnv(accountId).CODEX_HOME }
        envToDelete.push(
          'ORCA_CODEX_HOME',
          ...(await nativeCodexAuthEnvToDelete(
            env.CODEX_HOME,
            params.codexProfile,
            params.codexModelProvider
          ))
        )
      } else {
        const prepared = await preparePinnedClaudeAccountLaunch({
          accountId,
          getAccounts: () => runtime.requireStore().getSettings().claudeManagedAccounts ?? []
        })
        env = { ...prepared.envPatch }
        envToDelete.push(...CLAUDE_AUTH_ENV_VARS, 'ANTHROPIC_CUSTOM_HEADERS')
      }
    } else {
      const resolvers = runtime.getCommitMessageAgentEnvironmentResolvers()
      if (provider === 'codex' && resolvers?.prepareForCodexLaunch) {
        const home = await resolvers.prepareForCodexLaunch({ runtime: 'host' })
        env = home ? { CODEX_HOME: home } : {}
        envToDelete.push('CODEX_HOME', 'ORCA_CODEX_HOME')
        const selected = runtime.requireStore().getSettings().activeCodexManagedAccountId
        if (home && selected) {
          envToDelete.push(
            ...(await nativeCodexAuthEnvToDelete(
              home,
              params.codexProfile,
              params.codexModelProvider
            ))
          )
        }
      } else if (provider === 'claude' && resolvers?.prepareForClaudeLaunch) {
        const prepared = await resolvers.prepareForClaudeLaunch({ runtime: 'host' })
        env = { ...prepared.envPatch }
        if (prepared.provenance?.startsWith('profile:')) {
          envToDelete.push(...CLAUDE_AUTH_ENV_VARS, 'ANTHROPIC_CUSTOM_HEADERS')
        }
        envToDelete.push(
          'CLAUDE_CONFIG_DIR',
          'ORCA_CLAUDE_INJECTED_CONFIG_DIR',
          'ORCA_CLAUDE_PROFILE_POINTER'
        )
      } else {
        throw new Error('Native account selection is unavailable on this execution host')
      }
    }
    if (pool) {
      const current = getDefaultAccountPool(runtime, provider)
      if (current?.id !== pool.id || current.revision !== pool.revision) {
        throw new Error('Account pool changed while preparing the native CLI; retry the launch')
      }
    }
    return {
      env,
      envToDelete,
      executionMode,
      launchId,
      accountId: accountId ?? null,
      poolId: pool?.id ?? null,
      policyRevision: pool?.revision ?? null
    }
  } catch (error) {
    if (assignment) {
      db?.releaseAccountPoolAssignment(assignment.ownerKey)
    }
    throw error
  }
}

/** Only the owning local launcher may report its child's observed exit or failed spawn. */
export async function releaseNativeCliAccountLaunch(
  runtime: Runtime,
  launchId: string
): Promise<void> {
  if (await releaseNativeClaudeRoutingOwner(runtime, launchId)) {
    return
  }
  if (await revokeNativeCodexRoutingLaunch(runtime, launchId)) {
    return
  }
  runtime.getOrchestrationDb().releaseAccountPoolAssignment(ownerKey(launchId))
}
