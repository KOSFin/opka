import { readRuntimeNativeCliShellSetup } from '../../native-cli-shell-setup'
import { defineMethod } from '../core'
import {
  NativeClaudeRefreshSourceAccountParams,
  NativeClaudeRefreshSignInReference,
  NativeClaudeRefreshSignInCodeParams
} from '../../../../shared/native-claude-refresh-source'
import {
  beginRuntimeClaudeNativeSignIn,
  cancelRuntimeClaudeNativeSignIn,
  listRuntimeClaudeNativeSources,
  runtimeClaudeNativeSignInLink,
  submitRuntimeClaudeNativeCode
} from '../../runtime-claude-native-sources'

export const NATIVE_CLAUDE_REFRESH_SOURCE_METHODS = [
  defineMethod({
    name: 'accounts.nativeClaudeRefreshSources',
    permission: 'workspace',
    params: null,
    handler: async (_params, context) => {
      const state = await listRuntimeClaudeNativeSources(context.runtime)
      const shellSetup = await readRuntimeNativeCliShellSetup(context.runtime)
      return { accounts: state.accounts, shellSetup }
    }
  }),
  defineMethod({
    name: 'accounts.beginNativeClaudeRefreshSignIn',
    permission: 'workspace',
    params: NativeClaudeRefreshSourceAccountParams,
    handler: ({ accountId }, context) => beginRuntimeClaudeNativeSignIn(context.runtime, accountId)
  }),
  defineMethod({
    name: 'accounts.getNativeClaudeRefreshSignInLink',
    permission: 'workspace',
    params: NativeClaudeRefreshSignInReference,
    handler: (params, context) => runtimeClaudeNativeSignInLink(context.runtime, params)
  }),
  defineMethod({
    name: 'accounts.submitNativeClaudeRefreshSignInCode',
    permission: 'workspace',
    params: NativeClaudeRefreshSignInCodeParams,
    handler: (params, context) =>
      submitRuntimeClaudeNativeCode(context.runtime, params, params.code)
  }),
  defineMethod({
    name: 'accounts.cancelNativeClaudeRefreshSignIn',
    permission: 'workspace',
    params: NativeClaudeRefreshSignInReference,
    handler: (params, context) => cancelRuntimeClaudeNativeSignIn(context.runtime, params)
  })
]
