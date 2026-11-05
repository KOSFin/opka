import type { OrcaRuntimeService } from './orca-runtime'
import type { NativeCliTerminalOwner } from './native-cli-terminal-owner'

type Owner = {
  readOwner: () => NativeCliTerminalOwner | null
  usesAccount?: (accountId: string) => boolean
  onAttached?: () => void
  applyIdlePolicy?: (signal?: AbortSignal) => Promise<boolean>
  release: (proof?: { ownerAbsent: 'not-started' | 'exited' }) => Promise<boolean | void>
  unsubscribe?: () => void
  pty?: NativeCliTerminalOwner
  closing?: Promise<void>
}
const hosts = new WeakMap<object, Map<string, Owner>>()
type Runtime = Pick<OrcaRuntimeService, 'subscribeToPtyExit' | 'getPtyExecutionHostMetadata'>
export function registerNativeClaudeRoutingOwner(
  runtime: Runtime,
  launchId: string,
  owner: Owner
): void {
  let entries = hosts.get(runtime)
  if (!entries) {
    entries = new Map()
    hosts.set(runtime, entries)
  }
  if (entries.size >= 128 || entries.has(launchId)) {
    throw new Error('Claude native routing capacity is unavailable.')
  }
  entries.set(launchId, owner)
  try {
    attachNativeClaudeRoutingOwner(runtime, launchId)
  } catch (error) {
    owner.unsubscribe?.()
    if (entries.get(launchId) === owner) {
      entries.delete(launchId)
    }
    throw error
  }
}
export function attachNativeClaudeRoutingOwner(runtime: Runtime, launchId: string): void {
  const owner = hosts.get(runtime)?.get(launchId),
    pty = owner?.readOwner()
  if (!owner || !pty || owner.unsubscribe) {
    return
  }
  owner.pty = { ...pty }
  let ended = false
  const unsubscribe = runtime.subscribeToPtyExit(pty.ptyId, () => {
    try {
      if (runtime.getPtyExecutionHostMetadata(pty.ptyId).incarnationId !== pty.incarnationId) {
        return
      }
    } catch {
      return
    }
    ended = true
    void releaseNativeClaudeRoutingOwner(runtime, launchId, { ownerAbsent: 'exited' }).catch(
      () => {}
    )
  })
  if (ended) {
    unsubscribe()
  } else {
    owner.unsubscribe = unsubscribe
  }
  owner.onAttached?.()
}
export function isNativeClaudeRoutingLaunch(runtime: object, launchId: string): boolean {
  return hosts.get(runtime)?.has(launchId) === true
}
export function isNativeClaudeRoutingPty(
  runtime: object,
  ptyId: string,
  incarnationId: string | null | undefined
): boolean {
  if (!incarnationId) {
    return false
  }
  return [...(hosts.get(runtime)?.values() ?? [])].some((owner) => {
    const pty = owner.readOwner()
    return pty?.ptyId === ptyId && pty.incarnationId === incarnationId
  })
}
export async function releaseNativeClaudeRoutingOwner(
  runtime: object,
  launchId: string,
  proof?: { ownerAbsent: 'not-started' | 'exited' }
): Promise<boolean> {
  const entries = hosts.get(runtime),
    owner = entries?.get(launchId)
  if (!owner) {
    return false
  }
  if (!owner.closing) {
    owner.closing = (async () => {
      let retired = false
      try {
        retired = (await owner.release(proof)) !== false
      } finally {
        if (retired) {
          owner.unsubscribe?.()
          if (entries?.get(launchId) === owner) {
            entries.delete(launchId)
          }
        } else {
          owner.closing = undefined
        }
      }
    })()
  }
  await owner.closing
  return true
}

export async function applyNativeClaudeIdlePolicies(
  runtime: object,
  signal?: AbortSignal
): Promise<void> {
  const outcomes = await Promise.allSettled(
    [...(hosts.get(runtime)?.values() ?? [])].flatMap((owner) =>
      owner.applyIdlePolicy ? [owner.applyIdlePolicy(signal)] : []
    )
  )
  if (outcomes.some((outcome) => outcome.status === 'rejected')) {
    throw new Error(
      'The policy was saved, but an idle native Claude session could not apply it. Reconnect its account or restart that session.'
    )
  }
}

export function assertNativeClaudeAccountUnused(runtime: object, accountId: string): void {
  if ([...(hosts.get(runtime)?.values() ?? [])].some((owner) => owner.usesAccount?.(accountId))) {
    throw new Error('Close native Claude sessions using this account before removing it.')
  }
}
