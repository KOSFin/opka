import { createNativeClaudeQuotaConfirmation } from './native-claude-quota-confirmation'
import type { ClaudeNativeAccessSnapshot } from '../claude-accounts/claude-native-access'
import type { ClaudeNativeRefreshSources } from '../claude-accounts/claude-native-refresh-sources'
import type {
  ClaudeNativeGatewayOptions,
  ClaudeNativeGatewayRoute
} from '../claude-accounts/claude-native-gateway-route'

/** The HTTP front has already proved complete rejection with no client exposure. */
export function createNativeClaudeGatewayQuotaRetry(options: {
  sources: Pick<ClaudeNativeRefreshSources, 'refresh' | 'assertAccountOwned'>
  assertAccessCurrent: () => Promise<void>
  readOwner: () => { identity: string; sessionId: string } | null
  readPromptId: () => string | undefined
  readBoundary: () => () => boolean
  isCurrent: () => boolean
  prepareReplacement: (
    excluded: ReadonlySet<string>,
    signal: AbortSignal
  ) => Promise<ClaudeNativeGatewayRoute | null>
}) {
  let held = () => false
  let attempt:
    | { accountId: string; sessionId: string; owner: string; access: ClaudeNativeAccessSnapshot }
    | undefined
  const lifetime = new AbortController()
  const confirmation = createNativeClaudeQuotaConfirmation({
    readCurrent: () =>
      attempt && options.isCurrent() && options.readOwner()?.identity === attempt.owner
        ? attempt
        : null,
    refresh: (id, signal) => options.sources.refresh(id, signal),
    assertAccountOwned: (id) => options.sources.assertAccountOwned(id)
  })
  const retry: ClaudeNativeGatewayOptions['retryRejected'] = async ({
    route,
    excludedQuotaIdentities,
    signal
  }) => {
    held = options.readBoundary()
    const owner = options.readOwner(),
      promptId = options.readPromptId()
    const current = () =>
      !lifetime.signal.aborted &&
      !signal.aborted &&
      options.isCurrent() &&
      held() &&
      options.readOwner()?.identity === owner?.identity
    if (!owner || !promptId || !current()) {
      return null
    }
    const stop = AbortSignal.any([signal, lifetime.signal])
    await options.assertAccessCurrent()
    if (!current()) {
      return null
    }
    const access = await options.sources.refresh(route.accountId, stop)
    options.sources.assertAccountOwned(route.accountId)
    if (!current() || access.identity.accountUuid !== route.accountUuid) {
      return null
    }
    attempt = {
      accountId: route.accountId,
      sessionId: owner.sessionId,
      owner: owner.identity,
      access
    }
    try {
      const quota = await confirmation.confirm(
        { accountId: route.accountId, sessionId: owner.sessionId, promptId },
        current,
        stop
      )
      return quota && current()
        ? options.prepareReplacement(new Set(excludedQuotaIdentities), stop)
        : null
    } finally {
      attempt = undefined
    }
  }
  return {
    canReplace: () => !lifetime.signal.aborted && options.isCurrent() && held(),
    retry,
    close() {
      lifetime.abort()
      confirmation.close()
      held = () => false
      attempt = undefined
    }
  }
}
