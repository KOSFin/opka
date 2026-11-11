import { setTimeout } from 'node:timers/promises'
import { nativeCliParentTerminalContext } from '../shared/native-cli-parent-terminal'
import { TERMINAL_TASK_CALLER_FILE_ENV } from '../shared/terminal-task-caller-env'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'
import type {
  NativeCliAccountLaunch,
  NativeCliAccountLaunchRequest
} from '../shared/native-cli-account-launch'

export async function prepareNativeAgentExec(
  client: Pick<RuntimeClient, 'call'>,
  params: NativeCliAccountLaunchRequest,
  launchToken = process.env.ORCA_AGENT_LAUNCH_TOKEN
) {
  if (params.parentTerminal && launchToken) {
    try {
      return await client.call<NativeCliAccountLaunch>('accounts.prepareNativeCliLaunchV2', {
        ...params,
        startup: { version: 1, launchToken }
      })
    } catch (error) {
      // The registry rejects unknown methods before dispatch; transport uncertainty cannot retry.
      if (!(error instanceof RuntimeClientError) || error.code !== 'method_not_found') {
        throw error
      }
      process.stderr.write('[native-cli] This host cannot confirm native startup preparation.\n')
    }
  }
  return client.call<NativeCliAccountLaunch>('accounts.prepareNativeCliLaunch', params)
}

export async function nativeAgentStartupParentContext(env: NodeJS.ProcessEnv) {
  let context = nativeCliParentTerminalContext(env)
  if (!env.ORCA_AGENT_LAUNCH_TOKEN || !env[TERMINAL_TASK_CALLER_FILE_ENV]) {
    return context
  }
  const deadline = Date.now() + 2_000
  while (!context.parentTerminal && Date.now() < deadline) {
    await setTimeout(25)
    context = nativeCliParentTerminalContext(env)
  }
  return context
}
