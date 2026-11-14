import { nativeCliTerminalBindings } from './native-cli-terminal-bindings'
import type { OrcaRuntimeService } from './orca-runtime'
import type { NativeEngineSelection } from '../codex-routing/codex-engine-sessions'
import { NATIVE_CODEX_ROUTING_KEY_ENV } from '../../shared/native-cli-account-launch'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

const historyHomes = new Map<string, number>()
const retiringHomes = new Set<string>()
const retiringAccounts = new Set<string>()
export function claimNativeCodexHistoryHome(home: string, accountId?: string | null): () => void {
  const key = normalizeRuntimePathForComparison(home)
  if (retiringHomes.has(key) || (accountId && retiringAccounts.has(accountId))) {
    throw new Error('This native history account is being removed.')
  }
  historyHomes.set(key, (historyHomes.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const remaining = (historyHomes.get(key) ?? 1) - 1
    if (remaining) {
      historyHomes.set(key, remaining)
    } else {
      historyHomes.delete(key)
    }
  }
}
export async function withNativeCodexHistoryRetirement<T>(
  home: string,
  accountId: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = normalizeRuntimePathForComparison(home)
  if (retiringHomes.has(key) || retiringAccounts.has(accountId)) {
    throw new Error('This native history account is already being removed.')
  }
  assertNativeCodexHistoryHomeUnused(home)
  retiringHomes.add(key)
  retiringAccounts.add(accountId)
  try {
    return await operation()
  } finally {
    retiringHomes.delete(key)
    retiringAccounts.delete(accountId)
  }
}
export function assertNativeCodexHistoryHomeUnused(home: string): void {
  if (historyHomes.has(normalizeRuntimePathForComparison(home))) {
    throw new Error(
      'Close the native Codex dialog using this account’s history before removing the account.'
    )
  }
}

export type NativeCodexPtyOwner = { paneKey: string; ptyId: string; incarnationId: string }
type Runtime = Pick<
  OrcaRuntimeService,
  'getOrchestrationDb' | 'getPtyExecutionHostMetadata' | 'subscribeToPtyExit'
>
type RoutingOwner = {
  readOwner: () => NativeCodexPtyOwner | null
  revoke: () => Promise<void>
  dispose: () => void
  onPtyExit?: (owner: NativeCodexPtyOwner) => void
  initialOwnerKey?: string
  routingKey: string
  releaseHistory?: () => void
  selected?: NativeEngineSelection
  unsubscribe?: () => void
  pty?: NativeCodexPtyOwner
}
const owners = new WeakMap<object, Map<string, RoutingOwner>>()
export function assertNativeCodexRoutingCapacity(runtime: object, launchId: string): void {
  const entries = owners.get(runtime)
  if (entries?.has(launchId)) {
    throw new Error('Native Codex routing ownership is busy.')
  }
}
export function registerNativeCodexRoutingOwner(
  runtime: Runtime,
  launchId: string,
  owner: RoutingOwner
): void {
  assertNativeCodexRoutingCapacity(runtime, launchId)
  if (owner.initialOwnerKey && isNativeCodexRoutingAssignment(runtime, owner.initialOwnerKey)) {
    throw new Error('The initial account assignment already has a routing owner.')
  }
  let entries = owners.get(runtime)
  if (!entries) {
    entries = new Map()
    owners.set(runtime, entries)
  }
  entries.set(launchId, owner)
  attachNativeCodexRoutingOwner(runtime, launchId)
}
export function selectNativeCodexRoutingAccount(
  runtime: Runtime,
  launchId: string,
  selected: NativeEngineSelection
): void {
  const owner = owners.get(runtime)?.get(launchId)
  if (!owner) {
    throw new Error('The native Codex routing owner was revoked.')
  }
  owner.selected = selected
  attachNativeCodexRoutingOwner(runtime, launchId)
}
/** Called after external PTY registration too: the first HTTP admission may precede that registration. */
export function attachNativeCodexRoutingOwner(runtime: Runtime, launchId: string): void {
  const owner = owners.get(runtime)?.get(launchId)
  if (!owner) {
    return
  }
  const current = owner.readOwner()
  if (!current) {
    return
  }
  if (
    owner.pty &&
    (owner.pty.ptyId !== current.ptyId ||
      owner.pty.incarnationId !== current.incarnationId ||
      owner.pty.paneKey !== current.paneKey)
  ) {
    throw new Error('The native Codex PTY generation changed.')
  }
  owner.pty ??= { ...current }
  if (owner.selected?.assignmentOwnerKey) {
    runtime.getOrchestrationDb().bindAccountPoolAssignmentPty({
      ownerKey: owner.selected.assignmentOwnerKey,
      ptyId: current.ptyId,
      incarnationId: current.incarnationId
    })
  }
  if (!owner.unsubscribe) {
    let exited = false
    const unsubscribe = runtime.subscribeToPtyExit(current.ptyId, () => {
      if (
        runtime.getPtyExecutionHostMetadata(current.ptyId).incarnationId !== current.incarnationId
      ) {
        return
      }
      exited = true
      owner.onPtyExit?.(current)
      void revokeNativeCodexRoutingLaunch(runtime, launchId).catch(() => {})
    })
    owner.unsubscribe = unsubscribe
    if (exited) {
      unsubscribe()
    }
  }
}
/** Explicit capability revocation is independent of whether OS descendants have exited. */
export async function revokeNativeCodexRoutingLaunch(
  runtime: object,
  launchId: string
): Promise<boolean> {
  const entries = owners.get(runtime)
  const owner = entries?.get(launchId)
  if (!owner) {
    return false
  }
  entries?.delete(launchId)
  owner.unsubscribe?.()
  owner.dispose()
  try {
    await owner.revoke()
    owner.releaseHistory?.()
  } catch (error) {
    entries?.set(launchId, owner)
    throw error
  }
  return true
}
export function isNativeCodexRoutingLaunch(runtime: object, launchId: string): boolean {
  return owners.get(runtime)?.has(launchId) === true
}
export function isNativeCodexRoutingEnvironment(
  runtime: object,
  env: Readonly<Record<string, string>>
): boolean {
  const key = env[NATIVE_CODEX_ROUTING_KEY_ENV]
  return Boolean(
    key && [...(owners.get(runtime)?.values() ?? [])].some((owner) => owner.routingKey === key)
  )
}
export function isNativeCodexRoutingAssignment(
  runtime: object,
  ownerKey: string,
  excludingLaunchId?: string
): boolean {
  return [...(owners.get(runtime)?.entries() ?? [])].some(
    ([launchId, owner]) =>
      launchId !== excludingLaunchId &&
      (owner.selected?.assignmentOwnerKey === ownerKey || owner.initialOwnerKey === ownerKey)
  )
}
export function isNativeCodexRoutingPty(
  runtime: object,
  ptyId: string,
  incarnationId: string
): boolean {
  return [...(owners.get(runtime)?.values() ?? [])].some((owner) => {
    const current = owner.readOwner()
    return current?.ptyId === ptyId && current.incarnationId === incarnationId
  })
}

export function clearExitedNativeCodexBinding(
  runtime: object,
  launchId: string,
  owner: NativeCodexPtyOwner
): void {
  const bindings = nativeCliTerminalBindings(runtime)
  const binding = bindings.get(launchId)
  if (
    binding &&
    binding.paneKey === owner.paneKey &&
    binding.incarnationId === owner.incarnationId
  ) {
    binding.ended = true
    binding.inputReady = false
    binding.env = {}
    binding.waiters.forEach((notify) => notify())
    bindings.delete(launchId)
  }
}
