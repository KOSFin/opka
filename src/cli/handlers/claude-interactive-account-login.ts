import { setTimeout as delay } from 'node:timers/promises'
import type { HandlerContext } from '../dispatch'
import type { RuntimeRpcSuccess } from '../runtime-client'
import { RuntimeClientError } from '../runtime-client'
import type {
  ClaudeAccountSignIn,
  ClaudeRateLimitAccountsState
} from '../../shared/managed-account-types'
import { CLAUDE_AUTH_ENV_VARS } from '../../shared/claude-auth-environment'
import { buildWslExecArgs, buildWslLoginShellCommand } from '../../shared/wsl-login-shell-command'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import {
  type InteractiveLoginSession,
  terminateInteractiveLoginProcess
} from './interactive-login-interruption'

export const CLAUDE_INTERACTIVE_SIGN_IN_ARGS = [
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--tools',
  '',
  '--settings',
  '{"disableAllHooks":true}',
  '/login'
]
type RunLogin = (
  command: string,
  args: string[],
  extraEnv: Record<string, string>,
  json: boolean,
  session: InteractiveLoginSession
) => Promise<void>

async function stopOwnedSignIn(session: InteractiveLoginSession): Promise<void> {
  const child = session.child
  if (!child) {
    return
  }
  session.terminationPromise ??= terminateInteractiveLoginProcess(child, 'SIGTERM').then(() => {
    if (session.child === child && child.exitCode === null && child.signalCode === null) {
      throw new RuntimeClientError(
        'sign_in_stop_unconfirmed',
        'The Claude sign-in process could not be confirmed stopped. Close that terminal before trying again.'
      )
    }
  })
  await session.terminationPromise
}

/** Authentication is proven by the host's account state, never terminal text. */
export async function runInteractiveClaudeAccountLogin(
  { client, json }: Pick<HandlerContext, 'client' | 'json'>,
  signIn: ClaudeAccountSignIn,
  session: InteractiveLoginSession,
  runLogin: RunLogin
): Promise<RuntimeRpcSuccess<ClaudeRateLimitAccountsState>> {
  const env: Record<string, string> = Object.fromEntries(
    [
      ...CLAUDE_AUTH_ENV_VARS,
      'ANTHROPIC_CUSTOM_HEADERS',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY'
    ].map((key) => [key, ''])
  )
  env.CLAUDE_CONFIG_DIR = signIn.configDir
  const wsl = signIn.runtime === 'wsl' && signIn.wslDistro
  const command = wsl ? 'wsl.exe' : 'claude'
  const args = wsl
    ? buildWslExecArgs(signIn.wslDistro!, [
        '/bin/sh',
        '-c',
        buildWslLoginShellCommand(
          `exec env ${Object.entries(env)
            .map(([key, value]) => `${key}=${quotePosixShell(value)}`)
            .join(' ')} claude ${CLAUDE_INTERACTIVE_SIGN_IN_ARGS.map(quotePosixShell).join(' ')}`
        )
      ])
    : CLAUDE_INTERACTIVE_SIGN_IN_ARGS
  let exited = false
  let exitError: unknown
  const login = runLogin(command, args, wsl ? {} : env, json, session).then(
    () => {
      exited = true
    },
    (error: unknown) => {
      exited = true
      exitError = error
    }
  )
  const deadline = Date.now() + 10 * 60_000
  const identity = {
    accountId: signIn.accountId,
    runtime: signIn.runtime,
    wslDistro: signIn.wslDistro
  }
  try {
    while (Date.now() < deadline) {
      const { result } = await client.call<{ ready: boolean }>(
        'accounts.claudeSignInReady',
        identity
      )
      if (result.ready) {
        await stopOwnedSignIn(session)
        await login
        session.registering = true
        return await client.call<ClaudeRateLimitAccountsState>(
          'accounts.finishClaudeSignIn',
          identity
        )
      }
      if (exited) {
        throw (
          exitError ??
          new RuntimeClientError(
            'invalid_environment',
            'Claude exited before sign-in completed. Try again.'
          )
        )
      }
      await delay(1000)
    }
    throw new RuntimeClientError('timeout', 'Claude sign-in expired. Start a new sign-in.')
  } finally {
    await stopOwnedSignIn(session)
    await login
  }
}
