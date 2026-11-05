import type { CommandHandler } from '../dispatch'
import { runNativeAgentExec } from '../native-agent-exec'
import { attachNativeAgentTerminal } from '../native-agent-terminal'
import { NativeCliTerminalReference } from '../../shared/native-cli-terminal'
import { runNativeClaudeCoverage } from '../native-claude-coverage'
import { runNativeClaudePoolHook } from '../native-claude-pool-hook'
import { printResult } from '../format'

const nativeShell =
  (method: string): CommandHandler =>
  async ({ client, json }) => {
    if (client.isRemote) {
      throw new Error(
        'Run native-shell setup on the execution host whose terminal commands you want to manage.'
      )
    }
    const response = await client.call(method)
    printResult(response, json, (result) => JSON.stringify(result, null, 2))
  }

const nativeClaudeHook =
  (run: typeof runNativeClaudePoolHook): CommandHandler =>
  async ({ client, rawArgs }) => {
    const controller = new AbortController()
    const stop = () => {
      controller.abort()
      process.stdin.destroy()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      process.exitCode = await run(client, rawArgs ?? [], {
        stdin: process.stdin,
        env: process.env,
        signal: controller.signal,
        stdout: (text) => {
          process.stdout.write(text)
        },
        stderr: (text) => {
          process.stderr.write(text)
        }
      })
    } finally {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    }
  }

export const NATIVE_AGENT_EXEC_HANDLERS: Record<string, CommandHandler> = {
  'agent native-shell status': nativeShell('accounts.nativeCliIntegrationStatus'),
  'agent native-shell install': nativeShell('accounts.installNativeCliIntegration'),
  'agent native-shell uninstall': nativeShell('accounts.uninstallNativeCliIntegration'),
  'agent native-pool-observe': nativeClaudeHook(runNativeClaudeCoverage),
  'agent native-pool-hook': nativeClaudeHook(runNativeClaudePoolHook),
  'agent native-attach': async ({ client, rawArgs }) => {
    if (rawArgs?.length !== 1) {
      throw new Error('Expected agent native-attach <launch id>')
    }
    const { launchId } = NativeCliTerminalReference.parse({ launchId: rawArgs[0] })
    process.exitCode = await attachNativeAgentTerminal(client, launchId)
  },
  'agent native-exec': async ({ client, rawArgs }) => {
    process.exitCode = await runNativeAgentExec(client, rawArgs ?? [])
  }
}
