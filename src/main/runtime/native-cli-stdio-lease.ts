import { createHash, randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from './orca-runtime'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { NativeCliStdioOwner } from './native-cli-stdio-owner'
import type { NativeStdioReferenceVerdict } from './native-stdio-external-references'

/** A native invocation owns a real lease without creating a chat tab or storing its prompt. */
export async function reserveNativeCliStdioLease(
  runtime: Pick<
    OrcaRuntimeService,
    'openAgentSessionRecordStore' | 'getNativeCliAgentSessionClaimKeyId' | 'getRuntimeId'
  >,
  launchId: string,
  cwd: string,
  accountHome: string,
  readExternalReferences: (sessionId: string) => NativeStdioReferenceVerdict = () => 'unverifiable'
) {
  const store = await runtime.openAgentSessionRecordStore()
  const sessionId = `native_stdio_${randomUUID()}`
  const spawnToken = randomUUID()
  const now = Date.now()
  const operationId = `${now}-${launchId.replaceAll('-', '')}`
  const fingerprint = createHash('sha256').update(`native-stdio:${launchId}`).digest('hex')
  const location = {
    executionHostId: 'local' as const,
    wslDistro: null,
    workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
    workspaceKind: 'folder' as const
  }
  const { record } = await store.reserveOwner({
    sessionId,
    location,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: accountHome },
    launchDirectory: cwd,
    expectedFence: null,
    spawnToken,
    claimKeyId: runtime.getNativeCliAgentSessionClaimKeyId(),
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: { callerKey: 'native-stdio', operationId, fingerprint },
    now
  })
  // This receipt acknowledges the durable reservation, not a provider start or result.
  await store.recordOperationOutcome({
    callerKey: 'native-stdio',
    operationId,
    outcome: { status: 'succeeded', sessionId }
  })
  const fence = record.lease.runtimeFence
  let disposed = false
  let renewal: ReturnType<typeof setTimeout> | undefined
  let proveProcess: (() => Promise<boolean>) | undefined
  let processProven = false
  let releasedFence: number | undefined
  const scheduleRenewal = () => {
    renewal = setTimeout(() => {
      if (disposed) {
        return
      }
      void (async () => {
        if (!(await proveProcess?.()) || disposed) {
          processProven = false
          if (!disposed) {
            scheduleRenewal()
          }
          return
        }
        await store.renewLeases([
          {
            sessionId,
            fence,
            childProbe: { outcome: 'identity-matched', matchedOn: ['process-start-time'] },
            now: Date.now()
          }
        ])
        processProven = !disposed
        if (!disposed) {
          scheduleRenewal()
        }
      })().catch(() => {
        processProven = false
        if (!disposed) {
          scheduleRenewal()
        }
      })
    }, 10_000)
    renewal.unref()
  }
  return {
    store,
    sessionId,
    spawnToken,
    isCurrent: () => processProven && !disposed,
    async bind(
      pid: number,
      processStartTimeMs: number,
      prove: () => Promise<boolean>
    ): Promise<NativeCliStdioOwner> {
      const process: AgentSessionProcessIdentity = {
        hostId: store.hostId,
        pid,
        processStartTimeMs,
        spawnToken,
        runtime: runtime.getRuntimeId()
      }
      await store.commitProcessIdentity({ sessionId, fence, process, now: Date.now() })
      await store.proveOwner({ sessionId, fence, now: Date.now() })
      if (disposed) {
        throw new Error('Native CLI exited during process acquisition.')
      }
      proveProcess = prove
      processProven = true
      scheduleRenewal()
      return {
        sessionId,
        fence,
        process,
        subject: { kind: 'structured-session', sessionId, ...location }
      }
    },
    async release(proof: 'pid-absent' | 'not-started' | 'unverifiable') {
      disposed = true
      processProven = false
      clearTimeout(renewal)
      if (proof !== 'unverifiable') {
        if (releasedFence === undefined) {
          const released = await store.evictProvenDeadOwner({
            sessionId,
            expectedFence: fence,
            probe:
              proof === 'pid-absent'
                ? { outcome: 'pid-absent' }
                : { outcome: 'reservation-unused' },
            now: Date.now()
          })
          releasedFence = released.lease.runtimeFence
        }
        await store.nativeStdioRecords.retire({
          sessionId,
          releasedFence,
          operationId,
          fingerprint,
          proof,
          readExternalReferences: () => readExternalReferences(sessionId)
        })
      }
    }
  }
}
