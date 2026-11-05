import type { createNativeClaudeLiveRouting } from './native-claude-live-routing'
import { createNativeClaudeGatewayRouteSession } from './native-claude-gateway-route-session'
import { createNativeClaudeGatewayQuotaRetry } from './native-claude-gateway-quota-retry'
import { createNativeClaudeStdioSessionBoundary } from './native-claude-stdio-session-boundary'
import {
  readNativeCliStdioOwner,
  readNativeCliStdioObservationOwner
} from './native-cli-stdio-owner'
import { ownsNativeClaudeGatewaySession } from './native-claude-gateway-session-ownership'
import { NativeCliControlError } from '../../shared/native-cli-control-error'
import { registerNativeClaudeHookSession } from './native-claude-hook-sessions'
import { isNativeClaudeRoutingLaunch } from './native-claude-routing-ownership'
import { createNativeClaudePoolAffiliation } from './native-claude-pool-affiliation'
import { markNativeCliStdioControlFailure } from './native-cli-stdio-host'
import { accountPoolCandidates } from './account-pool-candidates'
import { agentHookServer } from '../agent-hooks/server'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import { readClaudeNativeRejectedRequestBoundary } from '../claude-accounts/claude-native-gateway-boundary'
import { startClaudeNativeGatewayHttp } from '../claude-accounts/claude-native-gateway-http'

/** One print invocation owns one selection controller; model responses never drive native wakes. */
export async function createNativeClaudeGatewayLiveRouting(
  options: Parameters<typeof createNativeClaudeLiveRouting>[0]
) {
  const {
    runtime,
    launchId,
    startedAt,
    capability,
    facade,
    sources,
    db,
    assertExclusive,
    bindCurrent
  } = options
  let closed = false
  let gateway: Awaited<ReturnType<typeof startClaudeNativeGatewayHttp>> | undefined
  let quota: ReturnType<typeof createNativeClaudeGatewayQuotaRetry> | undefined
  const current = () => !closed && isNativeClaudeRoutingLaunch(runtime, launchId)
  const boundary = createNativeClaudeStdioSessionBoundary({
    runtime,
    launchId,
    startedAt,
    isCurrent: current,
    isEnabled: () =>
      isAgentStatusHooksEnabledForAgent(runtime.requireStore().getSettings(), 'claude'),
    managedCoverage: true
  })
  const quiet = () => {
    const held = boundary.readBoundary()
    return {
      canSwitch: () => gateway?.readActiveRequests() === 0 && held.canSwitch(),
      onBoundaryAccepted: held.onBoundaryAccepted
    }
  }
  const affiliation = createNativeClaudePoolAffiliation({
    runtime,
    initialPoolId: options.initialPoolId,
    pinned: options.pinned,
    readAssignment: (ownerKey) =>
      db.listAccountPoolAssignments().find((row) => row.ownerKey === ownerKey) ?? null
  })
  const readCoverage = () => {
    const owner = readNativeCliStdioOwner(runtime, launchId),
      session = boundary.readOwner()
    const lead = owner ? agentHookServer.readNativeClaudeStructuredLead(owner.subject) : null
    if (
      !boundary.isSwitchOwnershipCurrent() ||
      !lead ||
      !session ||
      lead.lead.nativeCoverage?.sessionId !== session.sessionId
    ) {
      return undefined
    }
    return lead.lead.nativeCoverage
  }
  const readBackground = () => {
    const owner = readNativeCliStdioOwner(runtime, launchId),
      session = boundary.readOwner()
    return (
      !owner ||
      !session ||
      agentHookServer.hasNativeClaudeNonRequestBackgroundWork({
        kind: 'stdio',
        owner,
        launchId,
        sessionId: session.sessionId,
        startedAt
      })
    )
  }
  const readRejectedBoundary = () =>
    readClaudeNativeRejectedRequestBoundary({
      readCoverage,
      readOwner: () =>
        boundary.isSwitchOwnershipCurrent() ? (boundary.readOwner()?.identity ?? null) : null,
      activeHttp: () => gateway?.readActiveRequests() ?? 0,
      hasOwedBackgroundWork: readBackground
    })
  const controller = createNativeClaudeGatewayRouteSession({
    launchId,
    initialAccountId: options.initialAccountId,
    initialOwnerKey: options.initialOwnerKey,
    db,
    sources,
    acquireAssignment: options.acquireAssignment,
    readCandidates: () =>
      accountPoolCandidates(runtime.getAccountsSnapshot()).filter(
        (candidate) => candidate.provider === 'claude'
      ),
    readPolicy: affiliation.readPolicy,
    readManualAccountId: () =>
      options.pinned
        ? (options.pinnedAccountId ?? null)
        : runtime.getAccountsSnapshot().claude.activeAccountId,
    readOwner: boundary.readOwner,
    isCurrent: current,
    canReplace: () => quota?.canReplace() === true,
    readBoundary: quiet,
    readIdleBoundary: quiet,
    readInputVersion: () => {
      const state = readCoverage()
      return state ? `${state.generation}:${state.sequence}` : undefined
    },
    onAccountSelected: (selection) => {
      affiliation.onAccountSelected(selection)
      bindCurrent(selection)
    }
  })
  quota = createNativeClaudeGatewayQuotaRetry({
    sources,
    assertAccessCurrent: () => facade.assertAccessCurrent(),
    readOwner: boundary.readOwner,
    readPromptId: () => readCoverage()?.currentMainPromptId,
    readBoundary: readRejectedBoundary,
    isCurrent: current,
    prepareReplacement: controller.prepareReplacement
  })
  let unregister: (() => void) | undefined
  try {
    gateway = await startClaudeNativeGatewayHttp({
      capability,
      nativeAccountUuid: options.initialAccess.identity.accountUuid,
      prepare: async (request, signal) => {
        assertExclusive()
        await boundary.waitForOwner(signal)
        const actor = readNativeCliStdioObservationOwner(runtime, launchId),
          owner = boundary.readOwner()
        const canonical = actor
          ? agentHookServer.readNativeClaudeStructuredLead(actor.subject)?.lead.nativeCoverage
              ?.sessionId
          : undefined
        if (
          !ownsNativeClaudeGatewaySession(request, {
            currentSessionId: owner?.sessionId,
            canonicalSessionId: canonical,
            isKnownChild: (id) =>
              !!actor &&
              !!canonical &&
              agentHookServer.isKnownNativeClaudeChildSession(
                { kind: 'stdio', owner: actor, launchId, sessionId: canonical, startedAt },
                id
              )
          })
        ) {
          throw new NativeCliControlError('unsupported')
        }
        await facade.assertAccessCurrent()
        assertExclusive()
        return controller.prepareCurrent(signal)
      },
      retryRejected: quota.retry
    })
    unregister = registerNativeClaudeHookSession(runtime, launchId, {
      capability,
      observe: async (request, signal) => {
        assertExclusive()
        signal?.throwIfAborted()
        await boundary.waitForOwner(signal)
        bindCurrent(controller.assignment())
        const { ack, sealedStop } = await boundary.observe(request)
        if (request.observation.kind === 'control-failed') {
          markNativeCliStdioControlFailure(runtime, launchId)
        }
        if (request.observation.kind === 'request-start') {
          try {
            await facade.assertAccessCurrent()
          } catch (error) {
            markNativeCliStdioControlFailure(runtime, launchId)
            throw error
          }
        }
        if (sealedStop && ack.healthy && request.observation.kind === 'complete-stop') {
          await controller.applyAtBoundary(quiet(), signal)
        }
        assertExclusive()
        return ack
      },
      handle: async (request, signal) => {
        if (request.event !== 'prompt' && request.event !== 'stop') {
          return { action: 'none' }
        }
        await boundary.accept(request, signal)
        if (request.event === 'stop') {
          await controller.applyAtBoundary(quiet(), signal)
        }
        return { action: 'allow' }
      }
    })
    const transport = gateway
    const selectedQuota = quota
    let retiring: Promise<void> | undefined
    return {
      boundary,
      baseUrl: transport.baseUrl,
      session: {
        assignment: controller.assignment,
        usesAccount: controller.usesAccount,
        applyIdlePolicy: controller.applyIdlePolicy,
        dispose: async (proof: { releaseCurrent?: boolean } = {}) => {
          await controller.dispose(proof)
        }
      },
      unregister: () => {
        transport.revoke()
        closed = true
        unregister?.()
        selectedQuota.close()
        return (retiring ??= transport.close())
      }
    }
  } catch (error) {
    closed = true
    unregister?.()
    quota.close()
    gateway?.revoke()
    await gateway?.close()
    boundary.dispose()
    await controller.dispose({ releaseCurrent: false })
    throw error
  }
}
