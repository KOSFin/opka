import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import type { AgentStatusStructuredSessionSubject } from '../../shared/agent-status-subject'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { randomUUID } from 'node:crypto'
import { recordAgentSessionProviderHandle } from './agent-session-provider-handle-transition'
import { NativeCliControlError } from '../../shared/native-cli-control-error'

export type NativeCliStdioOwner = {
  sessionId: string
  subject: AgentStatusStructuredSessionSubject
  fence: number
  process: AgentSessionProcessIdentity
}
type StdioOwnerSlot = {
  owner: NativeCliStdioOwner | null
  store: AgentSessionRecordStore | null
  ended: boolean
  ready: Promise<void>
  notify: () => void
  isCurrent?: () => boolean
}
const slots = new WeakMap<object, Map<string, StdioOwnerSlot>>()

/** Transport ownership only; status remains in the hook server's canonical session store. */
export function stageNativeCliStdioOwner(runtime: object, launchId: string) {
  let entries = slots.get(runtime)
  if (!entries) {
    entries = new Map()
    slots.set(runtime, entries)
  }
  if (entries.has(launchId) || entries.size >= 64) {
    throw new NativeCliControlError(entries.has(launchId) ? 'owner_changed' : 'capacity')
  }
  let notify!: () => void
  const ready = new Promise<void>((resolve) => {
    notify = resolve
  })
  const slot: StdioOwnerSlot = { owner: null, store: null, ended: false, ready, notify }
  entries.set(launchId, slot)
  return {
    bind(owner: NativeCliStdioOwner, store: AgentSessionRecordStore, isCurrent?: () => boolean) {
      if (slot.ended || entries.get(launchId) !== slot || slot.owner) {
        throw new Error('Native CLI stdio owner changed before acquisition.')
      }
      slot.owner = owner
      slot.store = store
      slot.isCurrent = isCurrent
      slot.notify()
    },
    retire() {
      slot.ended = true
      slot.notify()
      if (entries.get(launchId) === slot) {
        entries.delete(launchId)
      }
    }
  }
}
export async function waitNativeCliStdioOwner(runtime: object, launchId: string) {
  const slot = slots.get(runtime)?.get(launchId)
  if (!slot) {
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      slot.ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Native CLI process acquisition timed out.')),
          6000
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
  return readNativeCliStdioOwner(runtime, launchId)
}
export async function commitNativeCliStdioProviderSession(
  runtime: object,
  launchId: string,
  nativeId: string
): Promise<void> {
  const slot = slots.get(runtime)?.get(launchId)
  const owner = readNativeCliStdioOwner(runtime, launchId)
  if (!slot?.store || !owner) {
    throw new Error('Native CLI session ownership is unavailable.')
  }
  await slot.store.transitionHandoff(owner.sessionId, (record) => {
    const head = record.providerHandleChain.at(-1)
    if (head?.handle.nativeId === nativeId) {
      return record
    }
    if (head) {
      throw new Error('Native CLI provider session changed without an owned context boundary.')
    }
    return recordAgentSessionProviderHandle({
      record,
      fence: owner.fence,
      now: Date.now(),
      link: {
        linkId: randomUUID(),
        origin: 'created',
        mintedAtFence: owner.fence,
        observedAt: Date.now(),
        handle: { transport: 'claude-sdk', agent: 'claude', nativeId }
      }
    })
  })
}
export function hasNativeCliStdioLaunch(runtime: object, launchId: string): boolean {
  const slot = slots.get(runtime)?.get(launchId)
  return !!slot && !slot.ended
}
export function readNativeCliStdioOwner(
  runtime: object,
  launchId: string
): NativeCliStdioOwner | null {
  return readOwner(runtime, launchId, false)
}
export function readNativeCliStdioObservationOwner(
  runtime: object,
  launchId: string
): NativeCliStdioOwner | null {
  return readOwner(runtime, launchId, true)
}
function readOwner(runtime: object, launchId: string, observationOnly: boolean) {
  const slot = slots.get(runtime)?.get(launchId)
  const owner = slot?.owner
  if (!slot || slot.ended || !owner || (!observationOnly && slot.isCurrent?.() === false)) {
    return null
  }
  const lease = slot.store?.getRecord(owner.sessionId)?.lease
  return lease?.claimStatus === 'live' &&
    !lease.unreconciled &&
    (observationOnly || lease.leaseDeadlineAt > Date.now()) &&
    lease.runtimeFence === owner.fence &&
    lease.ownerProcess?.pid === owner.process.pid &&
    lease.ownerProcess.processStartTimeMs === owner.process.processStartTimeMs &&
    lease.ownerProcess.spawnToken === owner.process.spawnToken
    ? owner
    : null
}
