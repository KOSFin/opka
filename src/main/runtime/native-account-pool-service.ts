import { join } from 'node:path'
import type { NativeAccountRotationBoundary } from '../native-chat/agent-session-wire/structured-account-acquisition'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { prepareAccountPoolResume } from './account-pool-resume'
import {
  selectAccountPoolRotationMember,
  isAccountPoolMemberHealthy
} from './account-pool-rotation-policy'
import { isDeepStrictEqual } from 'node:util'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { isNativeLocalLocation } from '../../shared/execution-host'
import { preparePinnedClaudeAccountLaunch } from '../claude-accounts/pinned-account-launch'
import { resolveWorkerCodexAccountHome } from '../codex-accounts/worker-account-home'
import type { OrcaRuntimeService } from './orca-runtime'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { pinAgentSessionAccountHome } from './agent-session-account-home-pin'
import { accountPoolCandidates } from './account-pool-candidates'
import { getAccountPoolPolicy, getDefaultAccountPool } from './runtime-account-pool-policy'

export type NativeAccountPoolRuntime = Pick<
  OrcaRuntimeService,
  'getOrchestrationDb' | 'getAccountsSnapshot' | 'requireStore'
>
export function createNativeAccountPoolService(args: {
  runtime: NativeAccountPoolRuntime
  store: Pick<AgentSessionRecordStore, 'reviseSessionRecord'>
}) {
  const { runtime, store } = args
  const ownerKey = (sessionId: string, fence: number, spawnToken: string) =>
    `native:${sessionId}:${fence}:${spawnToken}`
  return {
    async prepareAccountAcquisition(
      record: AgentSessionRecord,
      boundary?: NativeAccountRotationBoundary
    ) {
      record = structuredClone(record)
      const provider = record.provider
      if (
        (provider !== 'claude' && provider !== 'codex') ||
        !isNativeLocalLocation(record.location)
      ) {
        return { record }
      }
      const enrollment = record.accountPool
      // Never enroll an adopted conversation or an already used, unpooled chat.
      if (!enrollment && record.providerHandleChain.length > 0) {
        return { record }
      }
      const configured = enrollment
        ? getAccountPoolPolicy(runtime, enrollment.poolId)
        : getDefaultAccountPool(runtime, provider)
      if (!configured || configured.strategy === 'manual') {
        if (enrollment) {
          throw new Error('This chat account pool is paused; choose its policy before launching')
        }
        return { record }
      }
      if (configured.provider !== provider || !record.lease.reservedSpawnToken) {
        throw new Error('Native account pool startup reservation does not match this provider')
      }
      const spawnToken = record.lease.reservedSpawnToken
      const rotate = Boolean(
        enrollment &&
        boundary?.canRotate &&
        boundary.childrenSettled &&
        boundary.lastCompletedTurn &&
        enrollment.lastRotatedTurn !== boundary.lastCompletedTurn.id &&
        configured.rotation !== 'off' &&
        (configured.rotation === 'after-turn' ||
          configured.members.find((entry) => entry.accountId === enrollment.accountId)?.state !==
            'enabled' ||
          !isAccountPoolMemberHealthy(
            configured,
            accountPoolCandidates(runtime.getAccountsSnapshot()),
            enrollment.accountId
          ))
      )
      const candidates = accountPoolCandidates(runtime.getAccountsSnapshot()).filter(
        (entry) => entry.provider === provider
      )
      const selected =
        rotate && enrollment
          ? selectAccountPoolRotationMember(
              runtime.getOrchestrationDb().db,
              { policy: configured, candidates },
              enrollment.accountId
            )
          : undefined
      const fixedAccountId = selected?.id ?? enrollment?.accountId
      const policy = fixedAccountId
        ? {
            ...configured,
            members: configured.members.filter((entry) => entry.accountId === fixedAccountId)
          }
        : configured
      const db = runtime.getOrchestrationDb()
      const owner = ownerKey(record.sessionId, record.lease.runtimeFence, spawnToken)
      const assignment = db.acquireAccountPoolAssignment({
        ownerKey: owner,
        policy,
        candidates: accountPoolCandidates(runtime.getAccountsSnapshot()).filter(
          (entry) => entry.provider === provider
        )
      })
      try {
        const settings = runtime.requireStore().getSettings()
        const home =
          provider === 'codex'
            ? resolveWorkerCodexAccountHome(settings.codexManagedAccounts, assignment.accountId)
            : (
                await preparePinnedClaudeAccountLaunch({
                  accountId: assignment.accountId,
                  getAccounts: () =>
                    runtime.requireStore().getSettings().claudeManagedAccounts ?? []
                })
              ).configDir
        const accountHome = {
          variable: provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR',
          path: home
        }
        if (enrollment && !rotate && !isDeepStrictEqual(record.accountHome, accountHome)) {
          throw new Error('Native chat account pin changed during acquisition')
        }
        const current = getAccountPoolPolicy(runtime, configured.id)
        if (current.revision !== configured.revision) {
          throw new Error('Account pool changed while preparing this native chat')
        }
        if (enrollment && assignment.accountId !== enrollment.accountId) {
          if (!rotate || !('path' in record.accountHome)) {
            throw new Error('Native account rotation has no settled turn boundary')
          }
          const head = record.providerHandleChain.at(-1)
          if (!head) {
            throw new Error('Native account rotation has no resumable conversation')
          }
          const transcript = await resolveSessionFilePath(provider, head.handle.nativeId, {
            strictErrors: true,
            ...(provider === 'claude'
              ? { claudeProjectsDir: join(record.accountHome.path, 'projects') }
              : { codexSessionsDirs: [join(record.accountHome.path, 'sessions')] })
          })
          if (!transcript) {
            throw new Error('Native account rotation cannot verify its conversation history')
          }
          await prepareAccountPoolResume({
            provider,
            sourceHome: record.accountHome.path,
            targetHome: home,
            providerSession: {
              key: 'session_id',
              id: head.handle.nativeId,
              transcriptPath: transcript
            }
          })
        }
        const assertPolicy = () => {
          if (getAccountPoolPolicy(runtime, configured.id).revision !== configured.revision) {
            throw new Error('Account pool changed while preparing this native chat')
          }
        }
        assertPolicy()
        if (rotate) {
          boundary?.assertCurrent?.()
        }
        const pinned = await store.reviseSessionRecord(
          (latest) => {
            assertPolicy()
            if (rotate) {
              boundary?.assertCurrent?.()
            }
            if (
              latest.lease.runtimeFence !== record.lease.runtimeFence ||
              latest.lease.claimStatus !== 'reserved' ||
              latest.lease.ownerProcess !== null ||
              latest.lease.provenHandleLinkId !== null ||
              !isDeepStrictEqual(latest.providerHandleChain, record.providerHandleChain)
            ) {
              throw new Error('Native chat account rotation lost its startup reservation')
            }
            if (enrollment) {
              if (
                !isDeepStrictEqual(latest.accountPool, enrollment) ||
                !isDeepStrictEqual(latest.accountHome, record.accountHome) ||
                latest.lease.reservedSpawnToken !== record.lease.reservedSpawnToken
              ) {
                throw new Error('Native chat account pin changed during acquisition')
              }
              return {
                ...latest,
                accountHome,
                accountPool: {
                  poolId: configured.id,
                  accountId: assignment.accountId,
                  policyRevision: configured.revision,
                  ...(rotate && boundary?.lastCompletedTurn
                    ? { lastRotatedTurn: boundary.lastCompletedTurn.id }
                    : enrollment.lastRotatedTurn
                      ? { lastRotatedTurn: enrollment.lastRotatedTurn }
                      : {})
                },
                updatedAt: Date.now()
              }
            }
            const next = pinAgentSessionAccountHome(latest, {
              sessionId: record.sessionId,
              fence: record.lease.runtimeFence,
              spawnToken,
              expectedHome: record.accountHome,
              accountHome,
              now: Date.now()
            })
            return {
              ...next,
              accountPool: {
                poolId: configured.id,
                accountId: assignment.accountId,
                policyRevision: configured.revision
              }
            }
          },
          { sessionId: record.sessionId }
        )
        return { record: pinned, preSpawnFailed: () => db.releaseAccountPoolAssignment(owner) }
      } catch (error) {
        db.releaseAccountPoolAssignment(owner)
        throw error
      }
    },
    shouldRestForAccountRotation(
      record: AgentSessionRecord,
      boundary: NativeAccountRotationBoundary
    ) {
      if (
        !record.accountPool ||
        !boundary.canRotate ||
        !boundary.childrenSettled ||
        !boundary.lastCompletedTurn ||
        record.accountPool.lastRotatedTurn === boundary.lastCompletedTurn.id ||
        (record.provider !== 'claude' && record.provider !== 'codex')
      ) {
        return false
      }
      const policy = getAccountPoolPolicy(runtime, record.accountPool.poolId)
      const candidates = accountPoolCandidates(runtime.getAccountsSnapshot()).filter(
        (entry) => entry.provider === record.provider
      )
      if (
        policy.rotation === 'off' ||
        (policy.rotation === 'on-limit' &&
          isAccountPoolMemberHealthy(policy, candidates, record.accountPool.accountId))
      ) {
        return false
      }
      try {
        const selected = selectAccountPoolRotationMember(
          runtime.getOrchestrationDb().db,
          { policy, candidates },
          record.accountPool.accountId
        )
        return selected.id !== record.accountPool.accountId
      } catch {
        return false
      }
    },
    accountAcquisitionExited(exit: {
      sessionId: string
      fence: number
      generation: string | null
      spawnToken: string | null
    }) {
      if (!exit.spawnToken) {
        return
      }
      runtime
        .getOrchestrationDb()
        .releaseAccountPoolAssignment(ownerKey(exit.sessionId, exit.fence, exit.spawnToken))
    }
  }
}
