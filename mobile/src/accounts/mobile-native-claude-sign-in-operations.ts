import {
  NativeClaudeRefreshSignInReference,
  NativeClaudeRefreshSignInLinkResult,
  NativeClaudeRefreshSignInCodeParams,
  NativeClaudeRefreshSourcesResult,
  NativeClaudeRefreshSourceAccountParams
} from '../../../src/shared/native-claude-refresh-source'
import type { NativeClaudeSignInRequest } from '../../../src/shared/native-claude-sign-in-client'
import type { RpcClient } from '../transport/rpc-client'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

export const nativeClaudeSourcesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.native-claude-sources',
    method: 'accounts.nativeClaudeRefreshSources',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('sources', NativeClaudeRefreshSourcesResult)
  })
)
const begin = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.native-claude-sign-in',
    method: 'accounts.beginNativeClaudeRefreshSignIn',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('reference', NativeClaudeRefreshSignInReference)
  })
)
const read = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.native-claude-sign-in-link',
    method: 'accounts.getNativeClaudeRefreshSignInLink',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('link', NativeClaudeRefreshSignInLinkResult)
  })
)
const submit = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.native-claude-sign-in-code',
    method: 'accounts.submitNativeClaudeRefreshSignInCode',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('link', NativeClaudeRefreshSignInLinkResult)
  })
)
const cancel = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.cancel-native-claude-sign-in',
    method: 'accounts.cancelNativeClaudeRefreshSignIn',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('link', NativeClaudeRefreshSignInLinkResult)
  })
)
export function mobileNativeClaudeSignInRequest(client: RpcClient): NativeClaudeSignInRequest {
  return async (method, params) => {
    switch (method) {
      case 'accounts.beginNativeClaudeRefreshSignIn':
        return begin.interpret(
          await begin.request(client, NativeClaudeRefreshSourceAccountParams.parse(params))
        )
      case 'accounts.getNativeClaudeRefreshSignInLink':
        return read.interpret(
          await read.request(client, NativeClaudeRefreshSignInReference.parse(params))
        )
      case 'accounts.submitNativeClaudeRefreshSignInCode':
        return submit.interpret(
          await submit.request(client, NativeClaudeRefreshSignInCodeParams.parse(params))
        )
      case 'accounts.cancelNativeClaudeRefreshSignIn':
        return cancel.interpret(
          await cancel.request(client, NativeClaudeRefreshSignInReference.parse(params))
        )
      default:
        throw new Error('Unsupported native Claude sign-in operation')
    }
  }
}
