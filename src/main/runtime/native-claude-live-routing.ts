import { createNativeClaudeQuotaConfirmation } from './native-claude-quota-confirmation'
import { markNativeCliStdioControlFailure } from './native-cli-stdio-host'
import type { OrchestrationDb } from './orchestration/db/orchestration-db'
import type { NativeClaudeCoverageObservation } from '../../shared/native-claude-coverage'
import type { NativeCodexRoutingRuntime } from './native-codex-routing-launch'
import type { NativeCliTerminalOwner } from './native-cli-terminal-owner'
import type { ClaudeNativeRefreshSources } from '../claude-accounts/claude-native-refresh-sources'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import { createNativeClaudeSessionBoundary } from './native-claude-session-boundary'
import { createNativeClaudeRoutingSession } from './native-claude-routing-session'
import { registerNativeClaudeHookSession } from './native-claude-hook-sessions'
import { isNativeClaudeRoutingLaunch } from './native-claude-routing-ownership'
import { createNativeClaudePoolAffiliation } from './native-claude-pool-affiliation'
import { createNativeClaudeAccessRenewal } from './native-claude-access-renewal'
import type { ClaudeNativeAccessSnapshot } from '../claude-accounts/claude-native-access'
import { createNativeClaudeStdioSessionBoundary } from './native-claude-stdio-session-boundary'
import { hasNativeCliStdioLaunch } from './native-cli-stdio-owner'
import { accountPoolCandidates } from './account-pool-candidates'

export async function createNativeClaudeLiveRouting(options: {
  runtime: NativeCodexRoutingRuntime
  launchId: string
  startedAt: number
  capability: string
  initialAccountId: string
  initialAccess: ClaudeNativeAccessSnapshot
  initialPoolId?: string
  initialOwnerKey?: string
  acquireAssignment?: Parameters<typeof createNativeClaudeRoutingSession>[0]['acquireAssignment']
  pinned: boolean
  pinnedAccountId?: string | null
  sources: ClaudeNativeRefreshSources
  facade: Parameters<typeof createNativeClaudeRoutingSession>[0]['facade'] & {
    assertAccessCurrent: () => Promise<void>
  }
  db: Parameters<typeof createNativeClaudeRoutingSession>[0]['db'] & {
    listAccountPoolAssignments: () => ReturnType<OrchestrationDb['listAccountPoolAssignments']>
  }
  readPhysicalOwner: () => NativeCliTerminalOwner | null
  bindCurrent: (selection: { ownerKey?: string }) => void
  assertExclusive: () => void
}) {
  const {
    runtime,
    launchId,
    startedAt,
    capability,
    sources,
    facade,
    db,
    readPhysicalOwner,
    bindCurrent,
    assertExclusive,
    pinned
  } = options
  let session: ReturnType<typeof createNativeClaudeRoutingSession> | undefined
  let boundary:
    | ReturnType<typeof createNativeClaudeSessionBoundary>
    | ReturnType<typeof createNativeClaudeStdioSessionBoundary>
    | undefined
  let renewal: ReturnType<typeof createNativeClaudeAccessRenewal> | undefined
  let quota: ReturnType<typeof createNativeClaudeQuotaConfirmation> | undefined
  let currentAccess = options.initialAccess
  try {
    const sharedBoundary = {
      launchId,
      startedAt,
      isCurrent: () => isNativeClaudeRoutingLaunch(runtime, launchId),
      isEnabled: () =>
        isAgentStatusHooksEnabledForAgent(runtime.requireStore().getSettings(), 'claude'),
      managedCoverage: true as const,
      readOwnedWakeSubmission: () => session?.ownedWakeSubmission(),
      onObservedPrompt: (
        event: Extract<NativeClaudeCoverageObservation, { kind: 'prompt' }>,
        known: boolean
      ) => session?.observePrompt(event, known) ?? {}
    }
    boundary = hasNativeCliStdioLaunch(runtime, launchId)
      ? createNativeClaudeStdioSessionBoundary({ runtime, ...sharedBoundary })
      : createNativeClaudeSessionBoundary({
          ...sharedBoundary,
          transitions: runtime.agentTransitions,
          readPhysicalOwner,
          readTerminalContext: (owner) => {
            const pane = runtime.resolveTerminalPane(owner.paneKey)
            return pane.connected &&
              pane.executionHostId === 'local' &&
              pane.ptyId === owner.ptyId &&
              pane.incarnationId === owner.incarnationId
              ? {
                  ...owner,
                  tabId: pane.tabId,
                  worktreeId: pane.worktreeId,
                  executionHostId: 'local',
                  terminalHandle: pane.handle
                }
              : null
          }
        })
    const ownedBoundary = boundary
    const affiliation = createNativeClaudePoolAffiliation({
      runtime,
      initialPoolId: options.initialPoolId,
      pinned,
      readAssignment: (key) =>
        db.listAccountPoolAssignments().find((row) => row.ownerKey === key) ?? null
    })
    session = createNativeClaudeRoutingSession({
      launchId: launchId,
      initialAccountId: options.initialAccountId,
      managedCoverage: true,
      confirmQuotaFailure: (failure, canConfirm, signal) =>
        quota?.confirm(failure, canConfirm, signal) ?? Promise.resolve(false),
      acquireAssignment: options.acquireAssignment,
      initialOwnerKey: options.initialOwnerKey,
      db,
      sources,
      facade,
      readPolicy: affiliation.readPolicy,
      readManualAccountId: () =>
        pinned
          ? (options.pinnedAccountId ?? null)
          : runtime.getAccountsSnapshot().claude.activeAccountId,
      readCandidates: () =>
        accountPoolCandidates(runtime.getAccountsSnapshot()).filter(
          (candidate) => candidate.provider === 'claude'
        ),
      readOwner: ownedBoundary.readOwner,
      readBoundary: ownedBoundary.readBoundary,
      readIdleBoundary: ownedBoundary.readIdleBoundary,
      readCompletedSuccessfully: ownedBoundary.readCompletedSuccessfully,
      onAccountSelected: (selection) => {
        currentAccess = selection.access
        affiliation.onAccountSelected(selection)
        renewal?.selected(selection)
        bindCurrent(selection)
      }
    })
    const ownedSession = session
    renewal = createNativeClaudeAccessRenewal({
      initial: { accountId: options.initialAccountId, access: options.initialAccess },
      readAccountId: ownedSession.accountId,
      assertAccessCurrent: () => facade.assertAccessCurrent(),
      readOwnerIdentity: () => ownedBoundary.readOwner()?.identity ?? null,
      refresh: async (id, signal) => {
        const access = await sources.refresh(id, signal)
        sources.assertAccountOwned(id)
        return access
      },
      publish: async (access, isCurrent) => {
        await facade.publish(access, isCurrent)
        if (isCurrent()) {
          currentAccess = access
        }
      }
    })
    quota = createNativeClaudeQuotaConfirmation({
      readCurrent: () => {
        const owner = ownedBoundary.readOwner()
        return owner
          ? {
              accountId: ownedSession.accountId(),
              sessionId: owner.sessionId,
              owner: owner.identity,
              access: currentAccess
            }
          : null
      },
      refresh: (id, signal) => sources.refresh(id, signal),
      assertAccountOwned: (id) => sources.assertAccountOwned(id)
    })
    const ownedQuota = quota
    const ownedRenewal = renewal
    const unregister = registerNativeClaudeHookSession(runtime, launchId, {
      capability,
      observe: async (request, signal) => {
        assertExclusive()
        if (signal?.aborted) {
          throw new Error('Claude native continuity was stopped.')
        }
        await ownedBoundary.waitForOwner(signal)
        bindCurrent(ownedSession.assignment())
        const { ack, sealedStop } = await ownedBoundary.observe(request)
        if (
          request.observation.kind === 'turn-end' &&
          !request.observation.agentId &&
          request.observation.reason === 'answer'
        ) {
          ownedSession.observeAnswerComplete()
        }
        if (request.observation.kind === 'control-failed') {
          markNativeCliStdioControlFailure(runtime, launchId)
        }
        if (request.observation.kind === 'request-start') {
          try {
            await ownedRenewal.prepareRequest(signal)
          } catch (error) {
            markNativeCliStdioControlFailure(runtime, launchId)
            throw error
          }
        }
        if (sealedStop && ack.healthy && request.observation.kind === 'complete-stop') {
          await ownedSession.handle(
            {
              event: 'stop',
              launchId: launchId,
              capability,
              sessionId: request.sessionId,
              promptId: request.observation.promptId
            },
            signal
          )
        }
        assertExclusive()
        return ack
      },
      handle: async (request, signal) => {
        bindCurrent(ownedSession.assignment())
        await ownedBoundary.accept(request, signal)
        if (
          'isCurrentAccountOnly' in ownedBoundary &&
          ownedBoundary.isCurrentAccountOnly(request)
        ) {
          return { action: 'allow' }
        }
        return ownedSession.handle(request, signal)
      }
    })
    return {
      boundary,
      session,
      unregister: () => {
        unregister()
        ownedRenewal.close()
        ownedQuota.close()
      }
    }
  } catch (error) {
    renewal?.close()
    quota?.close()
    boundary?.dispose()
    await session?.dispose({ releaseCurrent: false })
    throw error
  }
}
