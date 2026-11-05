import { z } from 'zod'
import {
  AccountDeviceSignInParams,
  AccountDeviceSignInSchema,
  BeginAccountDeviceSignInParams
} from '../../../src/shared/account-device-sign-in'
import {
  AccountSignInTerminalSchema,
  OpenAccountSignInTerminalParams
} from '../../../src/shared/account-sign-in-terminal'
import { AccountSignInWorkspacesSchema } from '../../../src/shared/account-sign-in-workspaces'
import { AccountPoolViewSchema } from '../../../src/shared/account-pool-view'
import {
  BeginCodexRoutingSignInParams,
  NativeCodexRoutingStateSchema
} from '../../../src/shared/native-account-routing'
import type { AccountDeviceSignInRequest } from '../../../src/shared/account-device-sign-in-client'
import type { RpcClient } from '../transport/rpc-client'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

const beginSignIn = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.begin-device-sign-in',
    method: 'accounts.beginDeviceSignIn',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('sign-in', AccountDeviceSignInSchema)
  })
)
const readSignIn = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.device-sign-in',
    method: 'accounts.deviceSignIn',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('sign-in', AccountDeviceSignInSchema)
  })
)
const cancelSignIn = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.cancel-device-sign-in',
    method: 'accounts.cancelDeviceSignIn',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('sign-in', AccountDeviceSignInSchema)
  })
)
const beginRoutingSignIn = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.begin-routing-sign-in',
    method: 'accounts.beginCodexRoutingSignIn',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('sign-in', AccountDeviceSignInSchema)
  })
)
const readRoutingSignIn = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.routing-sign-in',
    method: 'accounts.codexRoutingSignIn',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('sign-in', AccountDeviceSignInSchema)
  })
)
const cancelRoutingSignIn = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.cancel-routing-sign-in',
    method: 'accounts.cancelCodexRoutingSignIn',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('sign-in', AccountDeviceSignInSchema)
  })
)
export const codexRoutingStateRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.native-routing-state',
    method: 'accounts.codexRoutingState',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('routing', NativeCodexRoutingStateSchema)
  })
)

export function mobileAccountDeviceSignInRequest(client: RpcClient): AccountDeviceSignInRequest {
  return async (method, params) => {
    switch (method) {
      case 'accounts.beginCodexRoutingSignIn':
        return beginRoutingSignIn.interpret(
          await beginRoutingSignIn.request(client, BeginCodexRoutingSignInParams.parse(params))
        )
      case 'accounts.codexRoutingSignIn':
        return readRoutingSignIn.interpret(
          await readRoutingSignIn.request(client, AccountDeviceSignInParams.parse(params))
        )
      case 'accounts.cancelCodexRoutingSignIn':
        return cancelRoutingSignIn.interpret(
          await cancelRoutingSignIn.request(client, AccountDeviceSignInParams.parse(params))
        )
      case 'accounts.beginDeviceSignIn':
        return beginSignIn.interpret(
          await beginSignIn.request(client, BeginAccountDeviceSignInParams.parse(params))
        )
      case 'accounts.deviceSignIn':
        return readSignIn.interpret(
          await readSignIn.request(client, AccountDeviceSignInParams.parse(params))
        )
      case 'accounts.cancelDeviceSignIn':
        return cancelSignIn.interpret(
          await cancelSignIn.request(client, AccountDeviceSignInParams.parse(params))
        )
      default:
        throw new Error('Unsupported account sign-in operation')
    }
  }
}

export const accountSignInWorkspacesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.sign-in-workspaces',
    method: 'worktree.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspaces', AccountSignInWorkspacesSchema)
  })
)
const signInTerminalOpen = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.open-sign-in-terminal',
    method: 'accounts.openSignInTerminal',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal', AccountSignInTerminalSchema)
  })
)
export async function openMobileAccountSignInTerminal(
  client: RpcClient,
  params: z.input<typeof OpenAccountSignInTerminalParams>
) {
  return signInTerminalOpen.interpret(
    await signInTerminalOpen.request(client, OpenAccountSignInTerminalParams.parse(params))
  )
}

export const accountPoolsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.pools',
    method: 'accountPool.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pools', AccountPoolViewSchema)
  })
)
// Only acceptance matters: the caller reloads the canonical pool after this write.
const mutationAck = z.unknown()
export const accountPoolUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.update-pool',
    method: 'accountPool.update',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pool-updated', mutationAck)
  })
)
