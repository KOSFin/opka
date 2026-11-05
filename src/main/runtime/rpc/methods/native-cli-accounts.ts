import { NativeClaudeCoverageParams } from '../../../../shared/native-claude-coverage'
import {
  dispatchNativeClaudeCoverage,
  dispatchNativeClaudeHook
} from '../../native-claude-hook-sessions'
import { defineMethod, type RpcContext } from '../core'
import {
  NativeCliAccountLaunchParams,
  NativeCliAccountReleaseParams
} from '../../../../shared/native-cli-account-launch'
import {
  prepareNativeCliAccountLaunch,
  releaseNativeCliAccountLaunch
} from '../../native-cli-account-launch'
import { NativeClaudeHookParams } from '../../../../shared/native-claude-hook'

export function assertNativeCliLocalCaller(context: RpcContext): void {
  if (context.clientKind !== undefined || (context.caller && context.caller.kind !== 'local-cli')) {
    throw new Error('Native CLI account preparation requires the owning host local CLI')
  }
}

export const NATIVE_CLI_ACCOUNT_METHODS = [
  defineMethod({
    name: 'accounts.nativeClaudeCoverage',
    permission: 'workspace',
    params: NativeClaudeCoverageParams,
    handler: (params, context) => {
      assertNativeCliLocalCaller(context)
      return dispatchNativeClaudeCoverage(context.runtime, params, context.signal)
    }
  }),
  defineMethod({
    name: 'accounts.nativeClaudeHook',
    permission: 'workspace',
    params: NativeClaudeHookParams,
    handler: async (params, context) => {
      assertNativeCliLocalCaller(context)
      return dispatchNativeClaudeHook(context.runtime, params, context.signal)
    }
  }),
  defineMethod({
    name: 'accounts.prepareNativeCliLaunch',
    permission: 'workspace',
    params: NativeCliAccountLaunchParams,
    handler: async (params, context) => {
      assertNativeCliLocalCaller(context)
      return prepareNativeCliAccountLaunch(context.runtime, params)
    }
  }),
  defineMethod({
    name: 'accounts.releaseNativeCliLaunch',
    permission: 'workspace',
    params: NativeCliAccountReleaseParams,
    handler: async ({ launchId }, context) => {
      assertNativeCliLocalCaller(context)
      await releaseNativeCliAccountLaunch(context.runtime, launchId)
      return { released: true }
    }
  })
]
