import type { StructuredAccountAcquisition } from './structured-account-acquisition'
import { isDeepStrictEqual } from 'node:util'
import { abortSignalReason } from '../../../shared/abort-signal-reason'
import type {
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import {
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError
} from './structured-agent-session-adapter'
import { rethrowAfterAgentSessionAcquisitionCleanup } from './structured-agent-session-provider-exit-proof'
import { journalIdentityFor } from './structured-agent-session-attach'
import type { AttachFlowInput } from './structured-agent-session-attach-flow'
import { mintStructuredAgentSessionStartupAttempt } from './structured-agent-session-startup-attempt'

/** The same process, whatever Orca runtime the store stamped on its record (`runtime`): that stamp
 *  is about who holds the process, not which process it is. */
function sameOwnerProcess(
  stored: AgentSessionProcessIdentity,
  acquired: AgentSessionProcessIdentity
): boolean {
  const { runtime: _storedRuntime, ...storedProcess } = stored
  const { runtime: _acquiredRuntime, ...acquiredProcess } = acquired
  return isDeepStrictEqual(storedProcess, acquiredProcess)
}

/** A reservation with no process behind it is only a promise to spawn; the
 * adapter makes it real and the store then grants the writer. */
export async function acquireOwner(
  input: AttachFlowInput,
  record: AgentSessionRecord
): Promise<{
  record: AgentSessionRecord
  acquisitionGeneration: string
}> {
  const fence = record.lease.runtimeFence
  const spawnToken = record.lease.reservedSpawnToken
  if (!spawnToken) {
    throw new Error('agent_session_ownership_unknown')
  }
  let account: StructuredAccountAcquisition | undefined
  let adapterInvoked = false
  try {
    try {
      await input.onAcquiring?.()
    } catch (error) {
      throw new AgentSessionPreSpawnError(error)
    }
    try {
      account = await input.prepareAccountAcquisition?.(
        record,
        input.readAccountRotationBoundary?.()
      )
      record = account?.record ?? record
    } catch (error) {
      throw new AgentSessionPreSpawnError(error)
    }
    const permissionMode = await input.launchPermissionMode?.(record)
    // Right before the spawn: a close, Stop or quit that landed during any wait above launches nothing.
    if (input.acquireSignal?.aborted) {
      throw new AgentSessionPreSpawnError(abortSignalReason(input.acquireSignal))
    }
    if (account) {
      const latest = input.store.getRecord(record.sessionId)
      if (
        !latest ||
        latest.lease.runtimeFence !== fence ||
        latest.lease.reservedSpawnToken !== spawnToken ||
        latest.lease.ownerProcess !== null
      ) {
        throw new AgentSessionPreSpawnError(
          new Error('Native account startup reservation changed during preparation')
        )
      }
      record = latest
    }
    const attempt = mintStructuredAgentSessionStartupAttempt({
      record,
      identity: journalIdentityFor(record, input.params),
      // Retries must recover the original reservation, not mint a second child.
      spawnToken,
      ...(permissionMode ? { permissionMode } : {}),
      ...(input.eventSink ? { events: input.eventSink } : {}),
      ...(input.acquireSignal ? { signal: input.acquireSignal } : {}),
      ...(input.startupOptions ? { startupOptions: input.startupOptions } : {}),
      ...(input.startupAttemptId ? { attemptId: input.startupAttemptId } : {})
    })
    const progress = input.onStartupAttempt?.(attempt)
    adapterInvoked = true
    const acquired = await input.adapter.acquire({
      ...attempt,
      ...(input.recordPhase ? { recordPhase: input.recordPhase } : {}),
      onSpawned: async (process) => {
        progress?.spawned()
        record = await input.store.commitProcessIdentity({
          sessionId: record.sessionId,
          fence,
          process,
          now: input.now()
        })
      }
    })
    if (record.lease.ownerProcess === null) {
      await input.store.commitProcessIdentity({
        sessionId: record.sessionId,
        fence,
        process: acquired.process,
        now: input.now()
      })
    } else if (!sameOwnerProcess(record.lease.ownerProcess, acquired.process)) {
      throw new Error('agent_session_ownership_unknown')
    }
    // The process owns the lease now; a handle the provider answers with is returned by `open`.
    const proved = await input.store.proveOwner({
      sessionId: record.sessionId,
      fence,
      ...(acquired.link ? { link: acquired.link } : {}),
      now: input.now()
    })
    return { record: proved, acquisitionGeneration: acquired.acquisitionGeneration }
  } catch (error) {
    if (!adapterInvoked || isAgentSessionPreSpawnError(error)) {
      await account?.preSpawnFailed?.()
      throw isAgentSessionPreSpawnError(error) ? error : new AgentSessionPreSpawnError(error)
    }
    return rethrowAfterAgentSessionAcquisitionCleanup(input.adapter, record.sessionId, error)
  }
}
