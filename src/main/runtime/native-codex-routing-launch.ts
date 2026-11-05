import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import { readNativeCodexRoutingContext } from './read-native-codex-routing-context'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import { createNativeCodexSessionAuthority } from './native-codex-session-authority'
import type { OrcaRuntimeService } from './orca-runtime'
import type {
  NativeCliAccountLaunch,
  NativeCliAccountLaunchRequest
} from '../../shared/native-cli-account-launch'
import {
  NATIVE_CLI_ACCOUNT_PIN_ENV,
  NATIVE_CLI_INITIAL_ASSIGNMENT_ENV,
  NATIVE_CODEX_ROUTING_KEY_ENV
} from '../../shared/native-cli-account-launch'
import type { AccountPoolPolicy } from '../../shared/account-pool-policy'
import { getAccountPoolPolicy } from './runtime-account-pool-policy'
import { createNativeCliTurnBoundary } from './native-cli-turn-boundary'
import { readNativeCodexRoutingPaneOwner } from './native-codex-routing-pane-owner'
import { verifyProjectTaskTerminalProof } from './project-task-terminal-proof'
import {
  getRuntimeCodexEngineHost,
  prepareRuntimeCodexNativeLaunch,
  supportsCodexEngineGateway
} from './runtime-codex-engine-host'
import { prepareNativeCodexRoutingHistory } from './native-codex-routing-history'
import { codexNativeRoutingLaunch } from '../codex-routing/codex-native-launch-config'
import {
  assertNativeCodexRoutingCapacity,
  clearExitedNativeCodexBinding,
  isNativeCodexRoutingAssignment,
  registerNativeCodexRoutingOwner,
  selectNativeCodexRoutingAccount,
  isNativeCodexRoutingLaunch,
  revokeNativeCodexRoutingLaunch
} from './native-codex-routing-ownership'

export type NativeCodexRoutingRuntime = Pick<
  OrcaRuntimeService,
  | 'requireStore'
  | 'getAccountsSnapshot'
  | 'getOrchestrationDb'
  | 'getCommitMessageAgentEnvironmentResolvers'
  | 'agentTransitions'
  | 'getOrchestrationDispatchAuthority'
  | 'resolveTerminalPane'
  | 'subscribeToPtyExit'
  | 'getPtyExecutionHostMetadata'
>

export async function prepareNativeCodexRoutingLaunch(
  runtime: NativeCodexRoutingRuntime,
  params: NativeCliAccountLaunchRequest,
  defaultPool?: AccountPoolPolicy
): Promise<NativeCliAccountLaunch | null> {
  if (params.provider !== 'codex') {
    return null
  }
  const startedAt = Date.now()
  const verified = params.parentTerminal
    ? verifyProjectTaskTerminalProof(runtime, params.parentTerminal)
    : null
  if (params.parentTerminal && !verified) {
    throw new Error('The owning terminal proof changed before native routing.')
  }
  const readOwner = () => readNativeCodexRoutingPaneOwner(runtime, params.launchId, verified)
  const originalOwner = readOwner()
  const previous =
    originalOwner && params.initialAssignmentOwnerKey
      ? runtime
          .getOrchestrationDb()
          .listAccountPoolAssignments()
          .find(
            (entry) =>
              entry.provider === 'codex' &&
              entry.ownerKey === params.initialAssignmentOwnerKey &&
              !isNativeCodexRoutingAssignment(runtime, entry.ownerKey) &&
              entry.ptyId === originalOwner.ptyId &&
              entry.incarnationId === originalOwner.incarnationId &&
              (!params.accountId || params.accountId === entry.accountId)
          )
      : undefined
  const policy = previous ? getAccountPoolPolicy(runtime, previous.poolId) : defaultPool
  const automatic = Boolean(
    policy && policy.strategy !== 'manual' && (policy.applyToNewWork || previous)
  )
  const accountId = previous ? undefined : params.accountId
  const selected = accountId ?? runtime.getAccountsSnapshot().codex.activeAccountId
  if (!automatic && !selected) {
    return null
  }
  const supported = supportsCodexEngineGateway()
  if (!supported && !automatic) {
    return null
  }
  const host = supported ? getRuntimeCodexEngineHost(runtime) : null
  if (!automatic && (!selected || !host?.readConnection(selected))) {
    return null
  }
  const historyContext = await readNativeCodexRoutingContext(runtime, params)
  if (!historyContext) {
    return null
  }
  if (!supported) {
    throw new Error(
      'Codex account pools require engine routing unavailable on this platform. Use manual native execution.'
    )
  }
  if (!host) {
    throw new Error('Native Codex routing is not installed on this host.')
  }
  const history = await prepareNativeCodexRoutingHistory(
    runtime,
    params,
    host.getNativeClientKey(),
    historyContext
  )
  const home = history.home
  let disposeBoundary = () => {}
  let disposeSources = () => {}
  let transport: Awaited<ReturnType<typeof prepareRuntimeCodexNativeLaunch>> = null
  let notifyRelease = () => {}
  try {
    if (automatic && previous && !host.readConnection(previous.accountId)) {
      throw new Error(
        'Connect the existing native account to routing before its assignment can be handed off.'
      )
    }
    if (
      automatic &&
      (!policy ||
        !policy.members.some(
          (member) => member.state === 'enabled' && host.readConnection(member.accountId)
        ))
    ) {
      throw new NativeCliControlError('accounts_not_connected')
    }
    assertNativeCodexRoutingCapacity(runtime, params.launchId)
    const sessionAuthority = createNativeCodexSessionAuthority(
      runtime,
      params.launchId,
      readOwner,
      history.home,
      () => transport?.readActiveRequests?.() === 0,
      () => isAgentStatusHooksEnabledForAgent(runtime.requireStore().getSettings(), 'codex')
    )
    const boundary = createNativeCliTurnBoundary({
      provider: 'codex',
      expectedSessionId: sessionAuthority.expectedSessionId,
      readNativeOwner: sessionAuthority.readNativeOwner,
      readNativeChildren: sessionAuthority.readNativeChildren,
      readRetainedNativeBoundary: sessionAuthority.readRetainedNativeBoundary,
      launchStartedAt: startedAt,
      transitions: runtime.agentTransitions
    })
    disposeBoundary = boundary.dispose
    disposeSources = sessionAuthority.dispose
    transport = await prepareRuntimeCodexNativeLaunch(runtime, {
      launchId: params.launchId,
      accountId,
      poolId: automatic ? policy?.id : undefined,
      initialAccountId: previous?.accountId,
      ownerPrefix: `native-cli:${params.launchId}`,
      canSwitch: () => sessionAuthority.boundary(boundary.snapshot()).canSwitch(),
      readBoundary: (nextTurn) => sessionAuthority.boundary(boundary.snapshot(), nextTurn),
      areRetainedTurnsSettled: sessionAuthority.areRetainedTurnsSettled,
      onRootTurnAccepted: sessionAuthority.onRootTurnAccepted,
      prepareQuotaRetry: sessionAuthority.prepareQuotaRetry,
      onRootThreadBound: (id, context) => {
        sessionAuthority.bindRoot(id, context)
        boundary.rootBound?.()
      },
      canReplaceRejectedRequest: sessionAuthority.canReplaceRejectedRequest,
      onAccountSelected: (selected) =>
        selectNativeCodexRoutingAccount(runtime, params.launchId, selected),
      initialAssignment:
        previous && automatic
          ? {
              ownerKey: previous.ownerKey,
              assertCurrent: () => {
                const current = readOwner()
                const assignment = runtime
                  .getOrchestrationDb()
                  .listAccountPoolAssignments()
                  .find((entry) => entry.ownerKey === previous.ownerKey)
                if (
                  !isNativeCodexRoutingLaunch(runtime, params.launchId) ||
                  isNativeCodexRoutingAssignment(runtime, previous.ownerKey, params.launchId) ||
                  !current ||
                  current.ptyId !== originalOwner?.ptyId ||
                  current.incarnationId !== originalOwner?.incarnationId ||
                  !assignment ||
                  assignment.provider !== 'codex' ||
                  assignment.ptyId !== current.ptyId ||
                  assignment.incarnationId !== current.incarnationId ||
                  assignment.accountId !== previous.accountId ||
                  assignment.poolId !== previous.poolId ||
                  assignment.policyRevision !== previous.policyRevision
                ) {
                  throw new Error('The existing native account assignment changed before handoff.')
                }
              }
            }
          : undefined
    })
    if (!transport) {
      boundary.dispose()
      sessionAuthority.dispose()
      history.release()
      return null
    }
    const ready = transport
    registerNativeCodexRoutingOwner(runtime, params.launchId, {
      readOwner,
      routingKey: ready.routingKey,
      releaseHistory: () => {
        sessionAuthority.dispose()
        history.release('unverifiable')
      },
      revoke: ready.revoke,
      initialOwnerKey: previous && automatic ? previous.ownerKey : undefined,
      onPtyExit: (owner) => clearExitedNativeCodexBinding(runtime, params.launchId, owner),
      dispose: () => {
        boundary.dispose()
        notifyRelease()
      }
    })
    if (!isNativeCodexRoutingLaunch(runtime, params.launchId)) {
      throw new Error('The native terminal exited before routing was prepared.')
    }
    notifyRelease = runtime.agentTransitions.subscribe((change) => {
      if (change.paneKey === readOwner()?.paneKey) {
        ready.notifyBoundaryChanged()
      }
    })
    const routing = codexNativeRoutingLaunch(ready)
    return {
      ...routing,
      env: { CODEX_HOME: home, ...routing.env },
      envToDelete: [
        'CODEX_HOME',
        'ORCA_CODEX_HOME',
        'OPENAI_API_KEY',
        'CODEX_API_KEY',
        'CODEX_ACCESS_TOKEN',
        'CODEX_SQLITE_HOME',
        'ORCA_WORKER_CODEX_ACCOUNT_ID',
        'ORCA_WORKER_CLAUDE_ACCOUNT_ID',
        NATIVE_CLI_ACCOUNT_PIN_ENV,
        NATIVE_CLI_INITIAL_ASSIGNMENT_ENV,
        NATIVE_CODEX_ROUTING_KEY_ENV
      ],
      launchId: params.launchId,
      accountId: null,
      poolId: automatic ? (policy?.id ?? null) : null,
      policyRevision: automatic ? (policy?.revision ?? null) : null,
      executionMode: 'inherit'
    }
  } catch (error) {
    disposeBoundary()
    notifyRelease()
    await (isNativeCodexRoutingLaunch(runtime, params.launchId)
      ? revokeNativeCodexRoutingLaunch(runtime, params.launchId)
      : transport?.revoke())
    disposeSources()
    history.release()
    throw error
  }
}
