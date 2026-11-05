import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import type * as NodePty from 'node-pty'
import { TerminalHost } from '../daemon/terminal-host'
import { createDaemonPtySubprocessHandle } from '../daemon/pty-subprocess/subprocess-handle'
import {
  nativeCliTerminalBindings,
  type NativeCliTerminalBinding
} from '../runtime/native-cli-terminal-bindings'
import { createNativeCliTerminalOwnerReader } from '../runtime/native-cli-terminal-owner'
import type { RuntimeTerminalResolvePane } from '../../shared/runtime-terminal-contracts'
import { parsePaneKey } from '../../shared/stable-pane-id'

/** Actual terminal-host session mints the incarnation; the adapter never invents process identity. */
export async function createOwnedClaudeNativePty(options: {
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
  paneKey: string
  launchId?: string
  bindingRuntime?: object
  onData: (data: string) => void
}) {
  const module = process.env.ORCA_CAPTURE_NODE_PTY_MODULE
  if (!module) {
    throw new Error('An explicit qualified node-pty module is required.')
  }
  const nodePty: typeof NodePty = createRequire(import.meta.url)(module)
  const ptyId = randomUUID(),
    launchId = options.launchId ?? randomUUID(),
    worktreeId = 'synthetic-owned-native-folder'
  const pane = parsePaneKey(options.paneKey)
  if (!pane) {
    throw new Error('The synthetic native pane must be a valid canonical address.')
  }
  const physical: { child?: NodePty.IPty } = {}
  const host = new TerminalHost({
    spawnSubprocess: () => {
      const child = nodePty.spawn(options.executable, options.args, {
        cwd: options.cwd,
        cols: 120,
        rows: 40,
        env: options.env
      })
      physical.child = child
      return createDaemonPtySubprocessHandle({
        process: child,
        shellPath: options.executable,
        spawnCwd: options.cwd,
        env: options.env,
        startupCommandDeliveredInShellArgs: true,
        reportsChildExitStatus: true,
        sessionId: ptyId,
        startupAgentRecognition: null
      })
    }
  })
  const runtime = {
    getOrchestrationDispatchAuthority: () => null,
    resolveTerminalPane: (): RuntimeTerminalResolvePane => {
      const session = host.listSessions().find((entry) => entry.sessionId === ptyId)
      return {
        handle: ptyId,
        tabId: pane.tabId,
        leafId: pane.leafId,
        ptyId,
        connected: session?.isAlive === true,
        incarnationId: session?.incarnationId,
        worktreeId,
        executionHostId: 'local',
        hostPlatform: process.platform
      }
    }
  }
  const readOwner = createNativeCliTerminalOwnerReader(runtime, { provider: 'claude', launchId })
  let exited = false
  const exitListeners = new Set<() => void>()
  try {
    const spawned = await host.createOrAttach({
      sessionId: ptyId,
      cols: 120,
      rows: 40,
      cwd: options.cwd,
      launchAgent: 'claude',
      streamClient: {
        onData: options.onData,
        onExit: () => {
          exited = true
          for (const listener of exitListeners) {
            listener()
          }
        }
      }
    })
    if (!spawned.pid || !spawned.incarnationId || physical.child?.pid !== spawned.pid) {
      throw new Error('The native PTY process cannot be associated with the terminal-host session.')
    }
    const sessions = host.listSessions()
    if (
      !sessions.some(
        (entry) =>
          entry.sessionId === ptyId &&
          entry.pid === spawned.pid &&
          entry.incarnationId === spawned.incarnationId &&
          entry.isAlive
      )
    ) {
      throw new Error('The native terminal host did not retain its physical process identity.')
    }
    const binding: NativeCliTerminalBinding = {
      launchId,
      paneKey: options.paneKey,
      worktreeId,
      rotating: false,
      waiters: new Set(),
      env: options.env,
      inputTail: Promise.resolve(),
      pendingInputChars: 0,
      cols: 120,
      rows: 40,
      incarnationId: spawned.incarnationId,
      inputReady: true
    }
    nativeCliTerminalBindings(runtime).set(launchId, binding)
    if (options.bindingRuntime) {
      nativeCliTerminalBindings(options.bindingRuntime).set(launchId, binding)
    }
    return {
      readOwner,
      resolvePane: runtime.resolveTerminalPane,
      subscribeExit: (listener: () => void) => {
        exitListeners.add(listener)
        return () => {
          exitListeners.delete(listener)
        }
      },
      ptyId,
      pid: spawned.pid,
      incarnationId: spawned.incarnationId,
      write: (text: string) => host.write(ptyId, text),
      dispose: async () => {
        nativeCliTerminalBindings(runtime).delete(launchId)
        if (options.bindingRuntime) {
          nativeCliTerminalBindings(options.bindingRuntime).delete(launchId)
        }
        if (!exited) {
          await host.kill(ptyId, { immediate: true })
        }
        await host.dispose()
      }
    }
  } catch (error) {
    if (!exited) {
      physical.child?.kill('SIGKILL')
    }
    await host.dispose()
    throw error
  }
}
