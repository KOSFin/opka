import { nativeCodexLaunchContext } from '../../shared/native-codex-launch-context'
import { isAbsolute } from 'node:path'
import type { z } from 'zod'
import type { OrcaRuntimeService } from './orca-runtime'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { NativeCliTerminalCreate } from '../../shared/native-cli-terminal'
import { NATIVE_CLI_PTY_CHILD_ENV } from '../../shared/native-cli-terminal'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { applyNativeCliAccountEnvironment } from '../../shared/native-cli-account-environment'
import {
  prepareNativeCliAccountLaunch,
  releaseNativeCliAccountLaunch
} from './native-cli-account-launch'
import { bindAccountPoolPtyExecution } from './account-pool-pty-ownership'
import { nativeCliTerminalBindings } from './native-cli-terminal-bindings'
import {
  attachNativeClaudeRoutingOwner,
  isNativeClaudeRoutingLaunch
} from './native-claude-routing-ownership'
import { nativeCliAccountContext } from '../../shared/native-cli-account-pin'
import { nativeCliExecutionMode } from './native-cli-execution-mode'
import { nativeCliParentTerminalContext } from '../../shared/native-cli-parent-terminal'
import { nativeCliLaunchArguments } from '../../shared/native-cli-launch-arguments'
import {
  attachNativeCodexRoutingOwner,
  isNativeCodexRoutingLaunch
} from './native-codex-routing-ownership'

const preparations = new WeakMap<
  OrcaRuntimeService,
  Map<string, Promise<{ launchId: string; paneKey: string; worktreeId: string }>>
>()

export async function createNativeCliTerminal(
  runtime: OrcaRuntimeService,
  params: z.infer<typeof NativeCliTerminalCreate>,
  signal?: AbortSignal
) {
  let pending = preparations.get(runtime)
  if (!pending) {
    pending = new Map()
    preparations.set(runtime, pending)
  }
  const joined = pending.get(params.launchId)
  if (joined) {
    return joined
  }
  const existing = nativeCliTerminalBindings(runtime).get(params.launchId)
  if (existing) {
    return {
      launchId: existing.launchId,
      paneKey: existing.paneKey,
      worktreeId: existing.worktreeId
    }
  }
  const operation = createNativeCliTerminalOnce(runtime, params, signal)
  pending.set(params.launchId, operation)
  try {
    return await operation
  } finally {
    pending.delete(params.launchId)
  }
}

/** Floating terminals own execution without registering the caller's cwd as a project. */
async function createNativeCliTerminalOnce(
  runtime: OrcaRuntimeService,
  params: z.infer<typeof NativeCliTerminalCreate>,
  signal?: AbortSignal
) {
  if (process.platform === 'win32' || !isAbsolute(params.executable) || !isAbsolute(params.cwd)) {
    throw new Error(
      'Native interactive terminal requires an owning Unix host and absolute executable/cwd'
    )
  }
  if (
    nativeCliExecutionMode(runtime, {
      interactive: true,
      ...nativeCliParentTerminalContext(params.env)
    }) !== 'host-pty'
  ) {
    throw new Error('An existing managed terminal must inherit its parent context')
  }
  const bindings = nativeCliTerminalBindings(runtime)
  const previous = bindings.get(params.launchId)
  if (previous) {
    return {
      launchId: previous.launchId,
      paneKey: previous.paneKey,
      worktreeId: previous.worktreeId
    }
  }
  let env: Record<string, string> = {}
  const terminal = await runtime.dedupeTerminalCreate(
    'native-cli',
    `id:${FLOATING_TERMINAL_WORKTREE_ID}`,
    params.launchId,
    false,
    async (selector, handle) => {
      const plan = await prepareNativeCliAccountLaunch(
        runtime,
        {
          ...params,
          ...nativeCliAccountContext(params.provider, params.env),
          ...(params.provider === 'claude'
            ? { claudeExecutable: params.executable }
            : {
                codexExecutable: params.executable,
                ...nativeCodexLaunchContext(params.args, params.cwd)
              })
        },
        { pendingTerminal: true }
      )
      const launchArgs = nativeCliLaunchArguments(params.provider, params.args, plan)
      const merged = applyNativeCliAccountEnvironment(params.env, plan)
      env = Object.fromEntries(
        Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined)
      )
      delete env.ELECTRON_RUN_AS_NODE
      delete env[NATIVE_CLI_PTY_CHILD_ENV]
      if (
        plan.accountId &&
        !isNativeClaudeRoutingLaunch(runtime, params.launchId) &&
        !isNativeCodexRoutingLaunch(runtime, params.launchId)
      ) {
        env[
          params.provider === 'claude'
            ? 'ORCA_WORKER_CLAUDE_ACCOUNT_ID'
            : 'ORCA_WORKER_CODEX_ACCOUNT_ID'
        ] = plan.accountId
      }
      let dispatched = false
      try {
        const result = await runtime.createTerminal(selector, {
          signal,
          command: `exec ${[params.executable, ...launchArgs].map(quotePosixShell).join(' ')}`,
          cwd: params.cwd,
          initialSize: { cols: params.cols, rows: params.rows },
          launchAgent: params.provider,
          startupCommandDelivery: 'shell-ready',
          env,
          launchConfig: {
            agentCommand: [params.executable, ...launchArgs].map(quotePosixShell).join(' '),
            agentArgs: params.args.map(quotePosixShell).join(' '),
            agentEnv: {}
          },
          preAllocatedHandle: handle,
          requireFreshPane: true,
          presentation: 'background',
          activate: false,
          surfaceOwner: false,
          onPtySpawnDispatched: () => {
            dispatched = true
          }
        })
        if (!result.ptyId || !result.incarnationId) {
          throw new Error('Native CLI terminal creation is unverifiable')
        }
        if (
          plan.poolId &&
          !isNativeCodexRoutingLaunch(runtime, params.launchId) &&
          !isNativeClaudeRoutingLaunch(runtime, params.launchId)
        ) {
          bindAccountPoolPtyExecution(
            runtime,
            `native-cli:${params.launchId}`,
            result.ptyId,
            result.incarnationId
          )
        }
        return result
      } catch (error) {
        if (!dispatched) {
          await releaseNativeCliAccountLaunch(runtime, params.launchId)
        }
        throw error
      }
    }
  )
  if (!terminal.paneKey || !terminal.incarnationId) {
    throw new Error('Native CLI terminal has no owning pane incarnation')
  }
  const binding = {
    launchId: params.launchId,
    paneKey: terminal.paneKey,
    worktreeId: terminal.worktreeId,
    rotating: false,
    waiters: new Set<() => void>(),
    env,
    inputTail: Promise.resolve(),
    pendingInputChars: 0,
    cols: params.cols,
    rows: params.rows,
    incarnationId: terminal.incarnationId,
    inputReady: false
  }
  bindings.set(params.launchId, binding)
  attachNativeCodexRoutingOwner(runtime, params.launchId)
  attachNativeClaudeRoutingOwner(runtime, params.launchId)
  return { launchId: binding.launchId, paneKey: binding.paneKey, worktreeId: binding.worktreeId }
}
