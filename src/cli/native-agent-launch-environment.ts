import type { NativeCliAccountLaunch } from '../shared/native-cli-account-launch'
import { stripElectronRunAsNode } from './runtime/launch'
import { applyNativeCliAccountEnvironment } from '../shared/native-cli-account-environment'
import {
  NATIVE_CODEX_ROUTING_KEY_ENV,
  NATIVE_CLI_INITIAL_ASSIGNMENT_ENV
} from '../shared/native-cli-account-launch'
import { NATIVE_CLI_PTY_CHILD_ENV } from '../shared/native-cli-terminal'

export function nativeAgentLaunchEnvironment(
  inherited: NodeJS.ProcessEnv,
  plan: Pick<NativeCliAccountLaunch, 'env' | 'envToDelete'>,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  return applyNativeCliAccountEnvironment(
    stripElectronRunAsNode(inherited),
    {
      env: plan.env,
      envToDelete: [
        ...plan.envToDelete,
        NATIVE_CODEX_ROUTING_KEY_ENV,
        NATIVE_CLI_PTY_CHILD_ENV,
        NATIVE_CLI_INITIAL_ASSIGNMENT_ENV
      ]
    },
    platform
  )
}
