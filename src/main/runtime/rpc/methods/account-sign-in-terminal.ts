import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { buildShellCommandFromArgv } from '../../../../shared/tui-agent-startup-shell'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { OpenAccountSignInTerminalParams } from '../../../../shared/account-sign-in-terminal'
import { prependOrcaCliDirToChildPath } from '../../../cli/orca-cli-child-path'
import { requireLocalRuntimeFileRoute } from '../../files/file-target'
import { defineMethod, type RpcContext } from '../core'
import { rpcCallerOperationKey } from '../rpc-caller-identity'

async function requireOwnWorkspace(context: RpcContext, selector: string): Promise<string> {
  const target = await context.runtime.resolveRuntimeFileTarget(selector)
  requireLocalRuntimeFileRoute(target)
  if (parseWslUncPath(target.worktree.path)) {
    throw new Error('Choose a native workspace on this account host to sign in.')
  }
  return `id:${target.worktree.id}`
}

export const ACCOUNT_SIGN_IN_TERMINAL_METHODS = [
  defineMethod({
    name: 'accounts.openSignInTerminal',
    permission: 'accounts-admin',
    params: OpenAccountSignInTerminalParams,
    handler: async ({ worktree, clientMutationId }, context) => {
      if (!context.caller) {
        throw new Error('Sign-in requires an authenticated caller.')
      }
      const canonical = await requireOwnWorkspace(context, worktree)
      const app = getAppEnvironment()
      const env: Record<string, string> = {}
      const cli = prependOrcaCliDirToChildPath(env, {
        isPackaged: app.isPackaged(),
        userDataPath: app.getPath('userData'),
        resourcesPath: process.resourcesPath
      })
      if (!cli) {
        throw new Error('This host has no account sign-in CLI. Update the server and try again.')
      }
      await access(cli, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      const command = buildShellCommandFromArgv(
        [cli, 'account', 'add', '--agent', 'claude', '--interactive-login'],
        process.platform === 'win32' ? 'powershell' : 'posix'
      )
      const terminal = await context.runtime.dedupeTerminalCreate(
        rpcCallerOperationKey(context.caller),
        canonical,
        `account-sign-in:${clientMutationId}`,
        false,
        async (selector, preAllocatedHandle) => {
          await requireOwnWorkspace(context, selector ?? canonical)
          return context.runtime.createTerminal(selector, {
            command,
            env,
            title: 'Sign in to Claude',
            focus: false,
            activate: false,
            presentation: 'background',
            ...(process.platform === 'win32' ? { shellOverride: 'powershell.exe' } : {}),
            ...(preAllocatedHandle ? { preAllocatedHandle } : {})
          })
        }
      )
      const pane = terminal.paneKey ? parsePaneKey(terminal.paneKey) : null
      if (!pane) {
        throw new Error(
          'The sign-in terminal opened without a pane identity. Open the chosen workspace to find it.'
        )
      }
      return { terminal: { ...terminal, tabId: pane.tabId, leafId: pane.leafId } }
    }
  })
]
