import { nativeCodexLaunchContext } from '../shared/native-codex-launch-context'
import { nativeCodexPositionalCommand, nativeCodexUsesRemote } from '../shared/codex-global-options'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { constants } from 'node:os'
import { spawnProcess } from '@orca/process-host'
import type { RuntimeClient } from './runtime-client'
import type { NativeCliAccountLaunch } from '../shared/native-cli-account-launch'
import {
  NATIVE_CLI_ACCOUNT_PIN_ENV,
  NATIVE_CODEX_ROUTING_KEY_ENV,
  NATIVE_CLI_INITIAL_ASSIGNMENT_ENV
} from '../shared/native-cli-account-launch'
import { nativeAgentLaunchEnvironment } from './native-agent-launch-environment'
import {
  nativeAgentAuthenticationCommand,
  nativeAgentNeedsAccount
} from './native-agent-account-command'
import { hasNativeClaudeGatewayEnvironment } from '../shared/native-cli-account-environment'
import { NATIVE_CLI_PTY_CHILD_ENV } from '../shared/native-cli-terminal'
import { shouldUseRendererBackedInteractiveTerminal } from './codex-command-classification'
import { quotePosixShell } from '../shared/shell-argument-quoting'
import { nativeCliLaunchArguments } from '../shared/native-cli-launch-arguments'
import { nativeCliParentTerminalContext } from '../shared/native-cli-parent-terminal'
import { resolveUnwrappedNativeCliCommand } from '../shared/native-cli-unwrapped-command'

/** Passthrough args belong to the native CLI, including flags unknown to this Opka version. */
export async function runNativeAgentExec(
  client: Pick<RuntimeClient, 'call'> & Partial<Pick<RuntimeClient, 'userDataPath' | 'isRemote'>>,
  argv: string[]
): Promise<number> {
  const [provider, executable, ...args] = argv
  if ((provider !== 'claude' && provider !== 'codex') || !executable || !isAbsolute(executable)) {
    throw new Error(
      'Expected agent native-exec <claude|codex> <absolute executable> [native args...]'
    )
  }
  const nativeExecutable = resolveUnwrappedNativeCliCommand(provider, executable)
  if (
    provider === 'claude' &&
    hasNativeClaudeGatewayEnvironment(process.env) &&
    nativeAgentAuthenticationCommand(provider, args)
  ) {
    throw new Error('Open a host shell outside the routed session for native Claude login.')
  }
  if (
    provider === 'codex' &&
    process.env[NATIVE_CODEX_ROUTING_KEY_ENV] &&
    (nativeCodexUsesRemote(args) ||
      process.env.CODEX_EXEC_SERVER_URL ||
      ['auth', 'login', 'logout'].includes(nativeCodexPositionalCommand(args) ?? ''))
  ) {
    throw new Error(
      'Open a host shell outside the routed session for native Codex login or remote execution.'
    )
  }
  const launchId = randomUUID()
  const pin = process.env[NATIVE_CLI_ACCOUNT_PIN_ENV]
  const accountId = pin?.startsWith(`${provider}:`) ? pin.slice(provider.length + 1) : undefined
  const codexOptions = provider === 'codex' ? nativeCodexLaunchContext(args, process.cwd()) : {}
  const needsAccount =
    nativeAgentNeedsAccount(provider, args) &&
    !(provider === 'codex' && process.env.CODEX_EXEC_SERVER_URL)
  const interactive = Boolean(
    !accountId &&
    process.platform !== 'win32' &&
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    shouldUseRendererBackedInteractiveTerminal([provider, ...args].map(quotePosixShell).join(' '))
  )
  const { result }: { result: NativeCliAccountLaunch } = needsAccount
    ? await client.call<NativeCliAccountLaunch>('accounts.prepareNativeCliLaunch', {
        provider,
        launchId,
        ...(provider === 'claude'
          ? { claudeExecutable: nativeExecutable }
          : { codexExecutable: nativeExecutable }),
        ...(accountId ? { accountId } : {}),
        ...(process.env[NATIVE_CLI_INITIAL_ASSIGNMENT_ENV]
          ? { initialAssignmentOwnerKey: process.env[NATIVE_CLI_INITIAL_ASSIGNMENT_ENV] }
          : {}),
        interactive,
        ...(provider === 'claude' && !interactive && process.platform !== 'win32'
          ? { stdio: true }
          : {}),
        ...nativeCliParentTerminalContext(process.env),
        ...codexOptions
      })
    : {
        result: {
          launchId,
          accountId: null,
          poolId: null,
          policyRevision: null,
          executionMode: 'inherit' as const,
          env: {},
          envToDelete: [
            NATIVE_CLI_ACCOUNT_PIN_ENV,
            NATIVE_CODEX_ROUTING_KEY_ENV,
            NATIVE_CLI_PTY_CHILD_ENV,
            'ORCA_WORKER_CLAUDE_ACCOUNT_ID',
            'ORCA_WORKER_CODEX_ACCOUNT_ID'
          ]
        }
      }
  if (result.executionMode === 'host-stdio') {
    if (typeof client.userDataPath !== 'string' || client.isRemote !== false) {
      throw new Error('Native stdio CLI requires the owning host client')
    }
    const { runNativeAgentStdio } = await import('./native-agent-stdio.js')
    return runNativeAgentStdio(
      { call: client.call.bind(client), userDataPath: client.userDataPath, isRemote: false },
      nativeExecutable,
      args
    )
  }
  if (result.executionMode === 'host-pty') {
    if (!interactive || typeof client.userDataPath !== 'string' || client.isRemote !== false) {
      throw new Error('Native interactive CLI requires the owning host client')
    }
    const { runNativeAgentTerminal } = await import('./native-agent-terminal.js')
    return runNativeAgentTerminal(
      { call: client.call.bind(client), userDataPath: client.userDataPath, isRemote: false },
      provider,
      nativeExecutable,
      args,
      codexOptions
    )
  }
  const env = nativeAgentLaunchEnvironment(process.env, result)
  const nativeArgs = nativeCliLaunchArguments(provider, args, result)
  let exitProven = false
  try {
    let child: ReturnType<typeof spawnProcess>
    try {
      child = spawnProcess({ program: nativeExecutable, args: nativeArgs, env, stdio: 'inherit' })
    } catch (error) {
      exitProven = true
      throw error
    }
    let spawned = false
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
    const forward = (signal: NodeJS.Signals) => {
      // The terminal already delivers Ctrl+C to the inherited foreground process group.
      if (signal !== 'SIGINT' || !process.stdin.isTTY) {
        child.kill(signal)
      }
    }
    const handlers = signals.map((signal) => {
      const handler = () => forward(signal)
      process.on(signal, handler)
      return handler
    })
    try {
      return await new Promise<number>((resolve, reject) => {
        child.once('spawn', () => {
          spawned = true
        })
        child.on('error', (error) => {
          if (!spawned) {
            exitProven = true
            reject(error)
          } else {
            process.stderr.write(
              '[account-pool] Child exit is unverifiable; waiting for its exit.\n'
            )
          }
        })
        child.once('exit', (code, signal) => {
          exitProven = true
          resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1))
        })
      })
    } finally {
      signals.forEach((signal, index) => process.removeListener(signal, handlers[index]))
    }
  } finally {
    // Lost contact or an unobserved child exit retains the slot as unverifiable.
    if (exitProven && needsAccount) {
      await client.call('accounts.releaseNativeCliLaunch', { launchId }).catch(() => {
        process.stderr.write(
          '[account-pool] Could not confirm account slot release on this host.\n'
        )
      })
    }
  }
}
