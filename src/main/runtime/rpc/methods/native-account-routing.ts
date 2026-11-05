import { defineMethod, type RpcContext } from '../core'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import { AccountDeviceSignInParams } from '../../../../shared/account-device-sign-in'
import { readRuntimeNativeCliShellSetup } from '../../native-cli-shell-setup'
import {
  BeginCodexRoutingSignInParams,
  NATIVE_CODEX_ROUTING_CAPABILITY,
  type NativeCodexRoutingState
} from '../../../../shared/native-account-routing'
import {
  getRuntimeCodexEngineHost,
  listRuntimeCodexRoutingAccounts,
  supportsCodexEngineGateway
} from '../../runtime-codex-engine-host'

function owner(context: RpcContext): string {
  if (!context.caller) {
    throw new Error('Account routing sign-in requires an authenticated caller.')
  }
  return rpcCallerOperationKey(context.caller)
}
function host(context: RpcContext) {
  const instance = getRuntimeCodexEngineHost(context.runtime)
  if (!instance) {
    throw new Error('Native Codex account routing is unavailable on this execution host.')
  }
  return instance
}

export const NATIVE_ACCOUNT_ROUTING_METHODS = [
  defineMethod({
    name: 'accounts.codexRoutingState',
    permission: 'workspace',
    params: null,
    handler: async (_, context): Promise<NativeCodexRoutingState> => {
      const base = { capability: NATIVE_CODEX_ROUTING_CAPABILITY, supported: false, accounts: [] }
      if (!supportsCodexEngineGateway()) {
        return { ...base, unavailableReason: 'platform' }
      }
      try {
        const engine = getRuntimeCodexEngineHost(context.runtime)
        if (!engine) {
          return { ...base, unavailableReason: 'host-ownership' }
        }
        return {
          ...base,
          supported: true,
          shellSetup: await readRuntimeNativeCliShellSetup(context.runtime),
          accounts: listRuntimeCodexRoutingAccounts(context.runtime).map((account) => {
            const connection = engine.readConnection(account.id)
            return {
              accountId: account.id,
              rosterRevision: account.rosterRevision,
              status: connection ? (connection.adopted ? 'ready' : 'connected') : 'needs-sign-in'
            }
          })
        }
      } catch {
        return { ...base, unavailableReason: 'host-ownership' }
      }
    }
  }),
  defineMethod({
    name: 'accounts.beginCodexRoutingSignIn',
    permission: 'accounts-admin',
    params: BeginCodexRoutingSignInParams,
    handler: (params, context) => {
      const caller = owner(context)
      return host(context).beginGrant(caller, params)
    }
  }),
  defineMethod({
    name: 'accounts.codexRoutingSignIn',
    permission: 'accounts-admin',
    params: AccountDeviceSignInParams,
    handler: ({ id }, context) => {
      const caller = owner(context)
      return host(context).grant(caller, id)
    }
  }),
  defineMethod({
    name: 'accounts.cancelCodexRoutingSignIn',
    permission: 'accounts-admin',
    params: AccountDeviceSignInParams,
    handler: ({ id }, context) => {
      const caller = owner(context)
      return host(context).cancelGrant(caller, id)
    }
  })
]
