import { prepareNativeCliStartup } from '../../native-cli-startup-prepare'
import { NativeClaudeCoverageParams } from '../../../../shared/native-claude-coverage'
import {
  dispatchNativeClaudeCoverage,
  dispatchNativeClaudeHook
} from '../../native-claude-hook-sessions'
import { defineMethod, type RpcContext } from '../core'
import {
  NativeCliAccountLaunchParams,
  NativeCliAccountLaunchV2Params,
  NativeCliAccountReleaseParams
} from '../../../../shared/native-cli-account-launch'
import {
  prepareNativeCliAccountLaunch,
  releaseNativeCliAccountLaunch
} from '../../native-cli-account-launch'
import { NativeClaudeHookParams } from '../../../../shared/native-claude-hook'
import { requireNativeCodexHomeContext } from '../../native-codex-home-context'
import { recoverCodexNativeHomeConfig } from '../../../codex-routing/codex-native-home-recovery'
import { inspectCodexNativeHomeConfig } from '../../../codex-routing/codex-native-home-inspection'
import {
  NativeCodexHomeProfileParams,
  NativeCodexHomeRecoveryApplyParams
} from '../../../../shared/native-codex-home-recovery-contract'

export function assertNativeCliLocalCaller(context: RpcContext): void {
  if (context.clientKind !== undefined || (context.caller && context.caller.kind !== 'local-cli')) {
    throw new Error('Native CLI account preparation requires the owning host local CLI')
  }
}

export const NATIVE_CLI_ACCOUNT_METHODS = [
  defineMethod({
    name: 'accounts.inspectNativeCodexHome',
    permission: 'accounts-admin',
    params: NativeCodexHomeProfileParams,
    handler: async (params, context) => {
      assertNativeCliLocalCaller(context)
      const owner = requireNativeCodexHomeContext(context.runtime)
      return inspectCodexNativeHomeConfig({
        ...owner,
        context: {
          nativeVersion: '0.166.0',
          ...(params.profile ? { profile: params.profile } : {})
        }
      })
    }
  }),
  defineMethod({
    name: 'accounts.recoverNativeCodexHome',
    permission: 'accounts-admin',
    params: NativeCodexHomeRecoveryApplyParams,
    handler: async (params, context) => {
      assertNativeCliLocalCaller(context)
      const owner = requireNativeCodexHomeContext(context.runtime)
      await recoverCodexNativeHomeConfig({
        ...owner,
        context: {
          nativeVersion: '0.166.0',
          ...(params.profile ? { profile: params.profile } : {})
        },
        request: params.request
      })
      return { applied: true, requestId: params.request.requestId }
    }
  }),
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
    name: 'accounts.prepareNativeCliLaunchV2',
    permission: 'workspace',
    params: NativeCliAccountLaunchV2Params,
    handler: async (params, context) => {
      assertNativeCliLocalCaller(context)
      return prepareNativeCliStartup(context.runtime, params)
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
