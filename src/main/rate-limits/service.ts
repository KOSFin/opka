import { usageMatchesAccount } from '../../shared/usage-account-provenance'
import {
  stampedCodexProviderFailure,
  verifiedCodexProviderFailure,
  type CodexProviderFailureAccountResolver,
  type CodexProviderFailureEvent
} from './codex-provider-failure'
import { RateLimitServiceConfiguration } from './service/service-configuration'

export type { InactiveCodexAccountInfo } from './service/service-types'

/**
 * Coordinates provider quota polling and publishes a stable rate-limit snapshot.
 * The implementation is layered by lifecycle, account selection, and fetch policy
 * so each module stays small while this path remains the public integration seam.
 */
export class RateLimitService extends RateLimitServiceConfiguration {
  /** The resolver reads current host registration/connection state synchronously, without auth I/O. */
  ingestCodexProviderFailure(
    event: CodexProviderFailureEvent,
    resolveAccount: CodexProviderFailureAccountResolver
  ): boolean {
    const proof = resolveAccount(event.accountId)
    if (!verifiedCodexProviderFailure(event, proof, Date.now()) || !proof) {
      return false
    }
    const active =
      this.codexFetchTarget.runtime === 'host' &&
      (proof.selected || usageMatchesAccount(this.state.codex, 'host', event.accountId))
    const inactive =
      this.inactiveCodexAccountsResolver?.().some((account) => account.id === event.accountId) ===
      true
    if (!active && !inactive && !proof.selected) {
      return false
    }
    this.codexProviderFailureAccountResolver = resolveAccount
    const previous =
      active && usageMatchesAccount(this.state.codex, 'host', event.accountId)
        ? this.state.codex
        : this.inactiveCodexCache.get(event.accountId)
    if ((previous?.usageMetadata?.confirmedProviderFailure?.observedAt ?? 0) > event.observedAt) {
      return false
    }
    const sample = stampedCodexProviderFailure(previous, event)
    this.codexFetchGeneration += 1
    this.inactiveCodexAccountsGeneration += 1
    this.inactiveCodexCache.set(event.accountId, sample)
    this.updateState({ ...this.state, codex: active ? sample : this.state.codex })
    return true
  }
}
