import type { CommandHandler } from '../dispatch'
import { runNativeAgentExec } from '../native-agent-exec'
import { attachNativeAgentTerminal } from '../native-agent-terminal'
import { NativeCliTerminalReference } from '../../shared/native-cli-terminal'
import { runNativeClaudeCoverage } from '../native-claude-coverage'
import { runNativeClaudePoolHook } from '../native-claude-pool-hook'
import { printResult } from '../format'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { RuntimeClientError } from '../runtime-client'

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
  'agent native-home status': async ({ client, json, rawArgs }) => {
    if (client.isRemote) {
      throw new Error('Inspect native routing on its execution host.')
    }
    if ((rawArgs?.length ?? 0) > 1) {
      throw new Error('Expected agent native-home status [profile]')
    }
    let response
    try {
      response = await client.call(
        'accounts.inspectNativeCodexHome',
        rawArgs?.[0] ? { profile: rawArgs[0] } : {}
      )
    } catch (error) {
      if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
        throw new Error(
          'This host does not support native HOME recovery. Use manual native Codex here.'
        )
      }
      throw error
    }
    printResult(response, json, (result) => JSON.stringify(result, null, 2))
  },
  'agent native-home apply': async ({ client, json, rawArgs }) => {
    if (client.isRemote) {
      throw new Error('Apply native routing recovery on its execution host.')
    }
    if (!rawArgs?.[0] || rawArgs.length > 2) {
      throw new Error('Expected agent native-home apply <request.json> [profile]')
    }
    let request: unknown
    try {
      request = JSON.parse(
        readNodeFileSyncWithinLimit(rawArgs[0], 64 * 1024, {
          regularFileOnly: true,
          noFollow: true
        }).buffer.toString('utf8')
      )
    } catch {
      throw new Error('The native HOME recovery request must be a readable JSON file under 64 KiB.')
    }
    let response
    try {
      response = await client.call('accounts.recoverNativeCodexHome', {
        request,
        ...(rawArgs[1] ? { profile: rawArgs[1] } : {})
      })
    } catch (error) {
      if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
        throw new Error(
          'This host does not support native HOME recovery. Use manual native Codex here.'
        )
      }
      throw error
    }
    printResult(response, json, (result) => JSON.stringify(result, null, 2))
  },
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
