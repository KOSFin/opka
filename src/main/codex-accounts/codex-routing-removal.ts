import { assertNativeCodexHistoryHomeUnused } from '../runtime/native-codex-routing-ownership'
import type {
  CodexManagedAccount,
  CodexRateLimitAccountsState
} from '../../shared/managed-account-types'

export type CodexRoutingRemoval = {
  assertHistoryUnused: (account: CodexManagedAccount) => void
  remove: (
    account: CodexManagedAccount,
    commitNativeRemoval: () => Promise<CodexRateLimitAccountsState>
  ) => Promise<CodexRateLimitAccountsState>
}

export async function removeCodexAccountWithRouting(options: {
  accountId: string
  requireAccount: (id: string) => CodexManagedAccount
  removeNative: (id: string) => Promise<CodexRateLimitAccountsState>
  beforeRemoval: () => void
  serialize: (
    commit: () => Promise<CodexRateLimitAccountsState>
  ) => Promise<CodexRateLimitAccountsState>
  routing?: CodexRoutingRemoval
}): Promise<CodexRateLimitAccountsState> {
  const assert = () => {
    const account = options.requireAccount(options.accountId)
    assertNativeCodexHistoryHomeUnused(account.managedHomePath)
    options.routing?.assertHistoryUnused(account)
    return account
  }
  const account = assert()
  options.beforeRemoval()
  const commit = async () => {
    assert()
    return options.removeNative(options.accountId)
  }
  return options.routing ? options.routing.remove(account, commit) : options.serialize(commit)
}
