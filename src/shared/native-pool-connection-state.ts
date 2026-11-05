import type { NativeCliShellSetup } from './native-cli-shell-setup'
import { NativeCodexRoutingStateSchema } from './native-account-routing'
import {
  NativeClaudeRefreshSourcesResult,
  type NativeClaudeRefreshSourceStatus
} from './native-claude-refresh-source'

export type NativePoolConnection =
  | {
      provider: 'codex'
      accountId: string
      status: 'needs-sign-in' | 'connected' | 'ready'
      rosterRevision: string
    }
  | {
      provider: 'claude'
      accountId: string
      status: NativeClaudeRefreshSourceStatus['state']
      nativeVersion?: string
    }
export type NativePoolConnectionState = {
  supported: boolean
  shellSetup?: NativeCliShellSetup
  accounts: NativePoolConnection[]
}

export function nativePoolConnectionMethod(provider: 'claude' | 'codex') {
  return provider === 'codex' ? 'accounts.codexRoutingState' : 'accounts.nativeClaudeRefreshSources'
}

export function readNativePoolConnectionState(
  provider: 'claude' | 'codex',
  value: unknown
): NativePoolConnectionState {
  if (provider === 'codex') {
    const state = NativeCodexRoutingStateSchema.parse(value)
    return {
      supported: state.supported,
      ...(state.shellSetup ? { shellSetup: state.shellSetup } : {}),
      accounts: state.accounts.map((account): NativePoolConnection => ({
        ...account,
        provider: 'codex'
      }))
    }
  }
  const state = NativeClaudeRefreshSourcesResult.parse(value)
  return {
    supported: true,
    ...(state.shellSetup ? { shellSetup: state.shellSetup } : {}),
    accounts: state.accounts.map((account): NativePoolConnection => ({
      provider: 'claude',
      accountId: account.accountId,
      status: account.state,
      nativeVersion: account.nativeVersion
    }))
  }
}
