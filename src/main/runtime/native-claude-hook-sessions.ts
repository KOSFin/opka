import type {
  NativeClaudeCoverageRequest,
  NativeClaudeCoverageAck
} from '../../shared/native-claude-coverage'
import { timingSafeEqual } from 'node:crypto'
import { NATIVE_CLAUDE_ROUTING_KEY_ENV } from '../../shared/native-claude-hook'
import type {
  NativeClaudeHookRequest,
  NativeClaudeHookReply
} from '../../shared/native-claude-hook'

export type NativeClaudeHookSession = {
  capability: string
  observe?: (
    request: NativeClaudeCoverageRequest,
    signal?: AbortSignal
  ) => Promise<NativeClaudeCoverageAck>
  handle: (request: NativeClaudeHookRequest, signal?: AbortSignal) => Promise<NativeClaudeHookReply>
}
const hosts = new WeakMap<object, Map<string, NativeClaudeHookSession>>()

function matchesCapability(expected: string | undefined, supplied: string): boolean {
  if (!expected || supplied.length > 256 || supplied.length !== expected.length) {
    return false
  }
  const actual = Buffer.from(supplied),
    wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

/** An environment marker alone cannot bypass this host's account admission. */
export function isNativeClaudeHookEnvironment(
  runtime: object,
  env: Readonly<Record<string, string>>
): boolean {
  const capability = env[NATIVE_CLAUDE_ROUTING_KEY_ENV]
  if (!capability || capability.length > 256) {
    return false
  }
  for (const session of hosts.get(runtime)?.values() ?? []) {
    if (matchesCapability(session.capability, capability)) {
      return true
    }
  }
  return false
}

export function registerNativeClaudeHookSession(
  runtime: object,
  launchId: string,
  session: NativeClaudeHookSession
): () => void {
  let entries = hosts.get(runtime)
  if (!entries) {
    entries = new Map()
    hosts.set(runtime, entries)
  }
  if (entries.size >= 128 || entries.has(launchId)) {
    throw new Error('Claude native launch ownership is unavailable.')
  }
  const owned = entries
  owned.set(launchId, session)
  return () => {
    if (owned.get(launchId) === session) {
      owned.delete(launchId)
    }
  }
}

function requireNativeClaudeHookSession(
  runtime: object,
  request: { launchId: string; capability: string },
  signal?: AbortSignal
) {
  const entry = hosts.get(runtime)?.get(request.launchId)
  if (!entry || !matchesCapability(entry.capability, request.capability) || signal?.aborted) {
    throw new Error('Claude native hook ownership is unavailable.')
  }
  return entry
}

export async function dispatchNativeClaudeHook(
  runtime: object,
  request: NativeClaudeHookRequest,
  signal?: AbortSignal
): Promise<NativeClaudeHookReply> {
  return requireNativeClaudeHookSession(runtime, request, signal).handle(request, signal)
}

export async function dispatchNativeClaudeCoverage(
  runtime: object,
  request: NativeClaudeCoverageRequest,
  signal?: AbortSignal
): Promise<NativeClaudeCoverageAck> {
  const entry = requireNativeClaudeHookSession(runtime, request, signal)
  if (!entry.observe) {
    throw new Error('Native Claude continuity ownership is unavailable.')
  }
  return entry.observe(request, signal)
}
