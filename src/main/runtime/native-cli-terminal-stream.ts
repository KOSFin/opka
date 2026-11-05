import type { RpcContext } from './rpc/core'
import { TERMINAL_SUBSCRIBE_METHODS } from './rpc/methods/terminal/terminal-subscribe-method'
import {
  nativeCliTerminalBindings,
  noteNativeCliTerminalReady,
  waitForNativeCliTerminalRotation
} from './native-cli-terminal-bindings'

/** Follows only the host's registered pane replacement; it never resumes a user prompt. */
export async function streamNativeCliTerminal(
  context: RpcContext,
  params: { launchId: string; cols: number; rows: number },
  emit: (event: unknown) => void
): Promise<void> {
  const { runtime, signal } = context
  const binding = nativeCliTerminalBindings(runtime).get(params.launchId)
  const subscribe = TERMINAL_SUBSCRIBE_METHODS[0]
  if (!binding || !subscribe) {
    throw new Error('Native CLI terminal ownership is unavailable')
  }
  if (binding.attached) {
    throw new Error('Native CLI terminal already has an input owner')
  }
  binding.attached = true
  binding.cols = params.cols
  binding.rows = params.rows
  try {
    while (!signal?.aborted) {
      await waitForNativeCliTerminalRotation(binding, signal)
      if (binding.rotationFailed) {
        throw new Error('Native CLI replacement is unverifiable; input was not replayed')
      }
      const pane = runtime.resolveTerminalPane(binding.paneKey, binding.worktreeId)
      if (pane.incarnationId !== binding.incarnationId) {
        throw new Error('Native CLI pane ownership changed')
      }
      emit({ type: 'native-cli-pane', handle: pane.handle, incarnationId: pane.incarnationId })
      await subscribe.handler(
        {
          terminal: pane.handle,
          client: { id: `native-cli:${params.launchId}`, type: 'desktop' },
          viewport: { cols: binding.cols, rows: binding.rows }
        },
        context,
        (event) => {
          emit(event)
          if (
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            event.type === 'scrollback'
          ) {
            noteNativeCliTerminalReady(binding)
          }
        }
      )
      if (signal?.aborted) {
        return
      }
      if (binding.rotating) {
        continue
      }
      const current = runtime.resolveTerminalPane(binding.paneKey, binding.worktreeId)
      if (current.incarnationId !== pane.incarnationId) {
        continue
      }
      const exit = await runtime.waitForTerminal(pane.handle, { condition: 'exit', timeoutMs: 1 })
      if (!exit.satisfied) {
        throw new Error('Native CLI exit is unverifiable; no process was stopped')
      }
      emit({ type: 'native-cli-exit', code: exit.exitCode ?? 1 })
      binding.ended = true
      for (const notify of binding.waiters) {
        notify()
      }
      nativeCliTerminalBindings(runtime).delete(params.launchId)
      return
    }
  } finally {
    binding.inputReady = false
    binding.attached = false
  }
}
