import { readNativeClaudeBootstrapAssignment } from './native-claude-bootstrap-assignment'
import { createNativeClaudeAssignmentBinding } from './native-claude-assignment-binding'
import { acquireClaudeNativeScopedAssignment } from './claude-native-scoped-assignment'
import {
  createNativeClaudeLaunchLiveMode,
  type NativeClaudeLaunchSession
} from './native-claude-launch-live-mode'
import { hasNativeCliStdioLaunch } from './native-cli-stdio-owner'
import { nativeClaudeGatewayCapabilitySnapshot } from './native-claude-gateway-capability'
import { withNativeClaudeLaunchPreparation } from './native-claude-launch-preparation'
import { assertClaudeNativeFacadeForLaunchAbsent } from '../claude-accounts/claude-native-facade-preparation'
import { readyNativeClaudePoolCandidates } from './native-claude-pool-candidates'
import { randomBytes } from 'node:crypto'
import type {
  NativeCliAccountLaunch,
  NativeCliAccountLaunchRequest
} from '../../shared/native-cli-account-launch'
import { NATIVE_CLAUDE_ROUTING_KEY_ENV } from '../../shared/native-claude-hook'
import { CLAUDE_MANAGED_OAUTH_ENV_VARS } from '../../shared/claude-auth-environment'
import { createClaudeNativeAccessFacade } from '../claude-accounts/claude-native-access-facade'
import {
  createClaudeNativePoolHookSettings,
  projectClaudeNativePoolPreferences
} from '../claude-accounts/claude-native-pool-hooks'
import {
  getRuntimeClaudeNativeSources,
  registerRuntimeClaudeNativePoolScope,
  getRuntimeClaudeNativeLaunchContext
} from './runtime-claude-native-sources'
import { createNativeCliTerminalOwnerReader } from './native-cli-terminal-owner'
import type { createNativeClaudeLiveRouting } from './native-claude-live-routing'
import { registerNativeClaudeRoutingOwner } from './native-claude-routing-ownership'
import { getDefaultAccountPool, getAccountPoolPolicy } from './runtime-account-pool-policy'
import { accountPoolCandidates } from './account-pool-candidates'
import type { NativeCodexRoutingRuntime } from './native-codex-routing-launch'

export async function prepareNativeClaudeRoutingLaunch(
  runtime: NativeCodexRoutingRuntime,
  params: NativeCliAccountLaunchRequest,
  pendingTerminal = false,
  assertCurrent?: () => void
): Promise<NativeCliAccountLaunch | null> {
  if (params.provider !== 'claude') {
    return null
  }
  return withNativeClaudeLaunchPreparation(runtime, params.launchId, () =>
    prepareNativeClaudeRoutingLaunchOnce(runtime, params, pendingTerminal, assertCurrent)
  )
}

async function prepareNativeClaudeRoutingLaunchOnce(
  runtime: NativeCodexRoutingRuntime,
  params: NativeCliAccountLaunchRequest,
  pendingTerminal: boolean,
  assertCurrent?: () => void
): Promise<NativeCliAccountLaunch | null> {
  const startedAt = Date.now(),
    sources = getRuntimeClaudeNativeSources(runtime),
    context = getRuntimeClaudeNativeLaunchContext(runtime)
  const defaultPolicy = getDefaultAccountPool(runtime, 'claude')
  const automatic =
    (!params.accountId || !!params.initialAssignmentOwnerKey) &&
    defaultPolicy &&
    defaultPolicy.strategy !== 'manual'
  if (!sources || !context) {
    if (automatic) {
      throw new Error('Claude native account sources are not configured on this host.')
    }
    return null
  }
  assertClaudeNativeFacadeForLaunchAbsent(context.dataRoot, params.launchId)
  if (!params.claudeExecutable) {
    if (automatic) {
      throw new Error('Update the native launcher before using this Claude pool.')
    }
    return null
  }
  if (!automatic) {
    const selected = params.accountId ?? runtime.getAccountsSnapshot().claude.activeAccountId
    const state = selected ? await sources.state(selected) : null
    assertCurrent?.()
    if (!selected || state?.state !== 'ready') {
      return null
    }
  }
  try {
    await sources.assertNativeCommand(params.claudeExecutable)
    assertCurrent?.()
  } catch (error) {
    if (!automatic) {
      return null
    }
    throw error
  }
  const readPhysicalOwner = createNativeCliTerminalOwnerReader(runtime, params),
    originalOwner = readPhysicalOwner()
  const db = runtime.getOrchestrationDb()
  if (
    db.listAccountPoolAssignments().some((row) => row.ownerKey === `native-cli:${params.launchId}`)
  ) {
    throw new Error('A prior native Claude launch assignment requires recovery.')
  }
  const previous = readNativeClaudeBootstrapAssignment(db, params, originalOwner)
  const pinned = !!params.accountId && !previous
  const policy = previous
    ? getAccountPoolPolicy(runtime, previous.poolId)
    : pinned
      ? undefined
      : getDefaultAccountPool(runtime, 'claude')
  const pooled = policy && policy.strategy !== 'manual'
  const ready = await sources.readyAccountIds()
  assertCurrent?.()
  const selected =
    previous?.accountId ?? params.accountId ?? runtime.getAccountsSnapshot().claude.activeAccountId
  if (!pooled && (!selected || !ready.has(selected))) {
    return null
  }
  const assignmentScope = registerRuntimeClaudeNativePoolScope(runtime)
  const assignment = (() => {
    try {
      return (
        previous ??
        (pooled
          ? acquireClaudeNativeScopedAssignment(db, assignmentScope, {
              policy,
              candidates: readyNativeClaudePoolCandidates(
                accountPoolCandidates(runtime.getAccountsSnapshot()).filter(
                  (candidate) => candidate.provider === 'claude'
                ),
                ready
              )
            })
          : undefined)
      )
    } catch (error) {
      assignmentScope.close()
      throw error
    }
  })()
  const accountId = assignment?.accountId ?? selected
  if (!accountId) {
    assignmentScope.close()
    throw new Error('Connect an existing Claude account to native routing before launching.')
  }
  const live = !!originalOwner || pendingTerminal
  const hookLaunch = live ? context.resolveHookLaunch?.() : null
  if (live && !hookLaunch) {
    if (assignment && !previous) {
      db.releaseAccountPoolAssignment(assignment.ownerKey)
    }
    assignmentScope.close()
    throw new Error('The owning host native hook launcher is unavailable.')
  }
  let facade: Awaited<ReturnType<typeof createClaudeNativeAccessFacade>> | undefined
  let session: NativeClaudeLaunchSession | undefined
  let boundary: Awaited<ReturnType<typeof createNativeClaudeLiveRouting>>['boundary'] | undefined
  let unregister: (() => void | Promise<void>) | undefined
  let gatewayBaseUrl: string | undefined
  const gatewayMode = hasNativeCliStdioLaunch(runtime, params.launchId)
  const capability = `${gatewayMode ? 'sk-ant-oat01-' : ''}${randomBytes(32).toString('hex')}`
  let moduleDirectory: string | undefined
  try {
    const access = await sources.refresh(accountId)
    assertCurrent?.()
    sources.assertAccountOwned(accountId)
    if (pooled) {
      const current = previous
        ? getAccountPoolPolicy(runtime, policy.id)
        : getDefaultAccountPool(runtime, 'claude')
      if (current?.id !== policy.id || current.revision !== policy.revision) {
        throw new Error('Claude pool changed while preparing the launch.')
      }
    }
    const bindCurrent = createNativeClaudeAssignmentBinding({
      db,
      readOwner: readPhysicalOwner,
      assertExclusive: context.assertExclusive
    })
    const hooks = hookLaunch
      ? createClaudeNativePoolHookSettings(params.launchId, hookLaunch, { nativeCoverage: true })
      : null
    facade = await createClaudeNativeAccessFacade({
      dataRoot: context.dataRoot,
      sessionId: params.launchId,
      target: { runtime: 'host', executionHostId: 'local' },
      userHome: context.userHome,
      userConfigDir: context.userConfigDir,
      snapshot: gatewayMode ? nativeClaudeGatewayCapabilitySnapshot(access, capability) : access,
      assertExclusive: context.assertExclusive,
      projectSettings: (settings) =>
        projectClaudeNativePoolPreferences(hooks?.remove(settings) ?? settings)
    })
    assertCurrent?.()
    const profile = facade
    if (live && hooks && hookLaunch) {
      const liveRouting = await createNativeClaudeLaunchLiveMode({
        home: profile.home,
        gateway: gatewayMode,
        hookLaunch,
        hooks,
        runtime,
        launchId: params.launchId,
        startedAt,
        capability,
        initialAccountId: accountId,
        initialAccess: access,
        initialPoolId: assignment?.poolId,
        initialOwnerKey: assignment?.ownerKey,
        acquireAssignment: (admission) =>
          acquireClaudeNativeScopedAssignment(db, assignmentScope, admission),
        pinned,
        pinnedAccountId: params.accountId,
        sources,
        facade: profile,
        db,
        readPhysicalOwner,
        bindCurrent,
        assertExclusive: context.assertExclusive
      })
      assertCurrent?.()
      moduleDirectory = liveRouting.moduleDirectory
      gatewayBaseUrl = liveRouting.baseUrl
      boundary = liveRouting.boundary
      session = liveRouting.session
      unregister = liveRouting.unregister
    }
    registerNativeClaudeRoutingOwner(runtime, params.launchId, {
      readOwner: readPhysicalOwner,
      usesAccount: (id) => (session ? session.usesAccount(id) : accountId === id),
      applyIdlePolicy: session?.applyIdlePolicy,
      onAttached: () => {
        try {
          bindCurrent(session?.assignment() ?? { ownerKey: assignment?.ownerKey })
        } catch {
          // A native prompt rechecks the binding and fails closed; the terminal stays attachable.
        }
        boundary?.recheck()
      },
      release: async (proof) => {
        const ownerAbsent = !!proof?.ownerAbsent
        const drained = ownerAbsent || (!gatewayMode && boundary?.canRevokeAndDrain() === true)
        await unregister?.()
        boundary?.dispose()
        if (ownerAbsent && boundary && 'retireCanonical' in boundary) {
          boundary.retireCanonical()
        }
        if (session) {
          await session.dispose({ releaseCurrent: drained })
        } else if (assignment && drained) {
          context.assertExclusive()
          db.releaseAccountPoolAssignment(assignment.ownerKey)
        }
        if (drained) {
          await profile.dispose()
          assignmentScope.close()
        }
        return drained
      }
    })
    return {
      env: {
        DISABLE_AUTOUPDATER: '1',
        ...(gatewayBaseUrl ? { ANTHROPIC_BASE_URL: gatewayBaseUrl } : {}),
        CLAUDE_CONFIG_DIR: profile.home,
        ORCA_CLAUDE_INJECTED_CONFIG_DIR: profile.home,
        ORCA_CLAUDE_USER_CONFIG_DIR: context.userConfigDir ?? '',
        ...(live ? { [NATIVE_CLAUDE_ROUTING_KEY_ENV]: capability } : {})
      },
      envToDelete: [
        ...CLAUDE_MANAGED_OAUTH_ENV_VARS,
        'ORCA_WORKER_CLAUDE_ACCOUNT_ID',
        'ORCA_CLAUDE_INJECTED_CONFIG_DIR',
        'ORCA_CLAUDE_PROFILE_POINTER',
        'OPKA_CLAUDE_ROUTING_KEY',
        'OPKA_CODEX_ROUTING_KEY',
        'ORCA_WORKER_CODEX_ACCOUNT_ID',
        'ORCA_NATIVE_CLI_ACCOUNT_PIN',
        'ORCA_NATIVE_CLI_INITIAL_ASSIGNMENT'
      ],
      launchId: params.launchId,
      accountId,
      ...(moduleDirectory ? { claudePluginDirs: [moduleDirectory] } : {}),
      poolId: assignment?.poolId ?? null,
      policyRevision: assignment ? (policy?.revision ?? assignment.policyRevision) : null,
      executionMode: 'inherit'
    }
  } catch (error) {
    await unregister?.()
    boundary?.dispose()
    if (session) {
      await session.dispose({ releaseCurrent: !previous })
    } else if (assignment && !previous) {
      context.assertExclusive()
      db.releaseAccountPoolAssignment(assignment.ownerKey)
    }
    if (facade) {
      await facade.dispose()
    }
    assignmentScope.close()
    throw error
  }
}
