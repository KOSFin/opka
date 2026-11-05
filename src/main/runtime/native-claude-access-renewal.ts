import { createHash } from 'node:crypto'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { ClaudeNativeAccessSnapshot } from '../claude-accounts/claude-native-access'

type Selection = { accountId: string; access: ClaudeNativeAccessSnapshot }
const identityKey = (snapshot: ClaudeNativeAccessSnapshot) =>
  JSON.stringify([
    snapshot.identity.accountUuid,
    snapshot.identity.organizationUuid,
    snapshot.identity.emailAddress.toLowerCase()
  ])
function project(selection: Selection) {
  return {
    accountId: selection.accountId,
    identity: identityKey(selection.access),
    expiresAt: selection.access.access.expiresAt,
    inference: selection.access.access.scopes.includes('user:inference'),
    version: createHash('sha256').update(selection.access.access.accessToken).digest('hex')
  }
}

/** Renewal changes access for the same identity, never the session's account selection. */
export function createNativeClaudeAccessRenewal(options: {
  initial: Selection
  refresh: (accountId: string, signal: AbortSignal) => Promise<ClaudeNativeAccessSnapshot>
  publish: (access: ClaudeNativeAccessSnapshot, isCurrent: () => boolean) => Promise<void>
  readAccountId: () => string
  readOwnerIdentity: () => string | null
  assertAccessCurrent?: () => Promise<void>
  now?: () => number
}) {
  let current = project(options.initial)
  let generation = 0
  let pending: { generation: number; operation: Promise<void> } | undefined
  const lifetime = new AbortController()
  const now = options.now ?? Date.now
  const unavailable = () => new Error('Native Claude access renewal could not be confirmed.')
  const assertCurrent = () => {
    if (
      lifetime.signal.aborted ||
      options.readAccountId() !== current.accountId ||
      !options.readOwnerIdentity()
    ) {
      throw unavailable()
    }
  }
  const prepareRequest = async (signal?: AbortSignal): Promise<void> => {
    assertCurrent()
    if (signal?.aborted) {
      throw unavailable()
    }
    if (options.assertAccessCurrent) {
      try {
        await options.assertAccessCurrent()
        assertCurrent()
        if (signal?.aborted) {
          throw unavailable()
        }
      } catch {
        throw unavailable()
      }
    }
    if (pending) {
      const held = pending
      try {
        await waitForPromiseWithSignal(held.operation, signal)
      } catch {
        if (held.generation === generation || signal?.aborted || lifetime.signal.aborted) {
          throw unavailable()
        }
      }
      return prepareRequest(signal)
    }
    if (current.inference && current.expiresAt > now() + 60_000) {
      return
    }
    const expected = current
    const epoch = generation
    const owner = options.readOwnerIdentity()
    const request = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal
    const matches = () =>
      owner !== null &&
      !request.aborted &&
      generation === epoch &&
      current === expected &&
      options.readAccountId() === expected.accountId &&
      options.readOwnerIdentity() === owner
    const operation = (async () => {
      try {
        const access = await options.refresh(expected.accountId, request)
        if (
          !matches() ||
          identityKey(access) !== expected.identity ||
          !access.access.accessToken ||
          !Number.isFinite(access.access.expiresAt) ||
          !access.access.scopes.includes('user:inference') ||
          access.access.expiresAt <= now() + 30_000
        ) {
          throw unavailable()
        }
        await options.publish(access, matches)
        if (!matches()) {
          throw unavailable()
        }
        current = project({ accountId: expected.accountId, access })
        generation++
      } catch {
        throw unavailable()
      }
    })()
    const held = { generation: epoch, operation }
    pending = held
    void operation
      .finally(() => {
        if (pending === held) {
          pending = undefined
        }
      })
      .catch(() => {})
    await operation
  }
  return {
    prepareRequest,
    selected(selection: Selection) {
      const next = project(selection)
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        current = next
        generation++
      }
    },
    close() {
      lifetime.abort()
    }
  }
}
