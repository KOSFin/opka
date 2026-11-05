import type { OrcaRuntimeService } from './orca-runtime'
import { assertTerminalInputWithinLimit } from '../../shared/terminal-input'
import {
  nativeCliTerminalBindings,
  waitForNativeCliTerminalInput
} from './native-cli-terminal-bindings'
import { isTerminalInputLockedForClient } from './rpc/methods/terminal/terminal-input-delivery'
import { isUntypedTerminalInput } from '../../shared/terminal-untyped-input'

class NativeCliInputDeferred extends Error {}

/** One bounded, serialized chunk is never retried after crossing the provider's write boundary. */
export async function writeNativeCliTerminalInput(
  runtime: OrcaRuntimeService,
  launchId: string,
  text: string,
  sourceIncarnationId?: string,
  signal?: AbortSignal
): Promise<void> {
  assertTerminalInputWithinLimit(text, 4096)
  const binding = nativeCliTerminalBindings(runtime).get(launchId)
  if (!binding) {
    throw new Error('Native CLI terminal ownership is unavailable')
  }
  const source = sourceIncarnationId ?? binding.incarnationId
  if (isUntypedTerminalInput(text) && (binding.rotating || source !== binding.incarnationId)) {
    return
  }
  if (source !== binding.incarnationId && source !== binding.previousIncarnation) {
    throw new Error('Native CLI input source is unverifiable')
  }
  if (binding.pendingInputChars + text.length > 8192) {
    throw new Error('Native CLI input is backpressured; no input was accepted')
  }
  binding.pendingInputChars += text.length
  const write = async () => {
    for (;;) {
      if (signal?.aborted) {
        throw new Error('Native CLI input detached before delivery')
      }
      await waitForNativeCliTerminalInput(binding, signal)
      if (binding.rotationFailed) {
        throw new Error('Native CLI replacement is unverifiable; input was not replayed')
      }
      const pane = runtime.resolveTerminalPane(binding.paneKey, binding.worktreeId)
      if (pane.incarnationId !== binding.incarnationId) {
        throw new Error('Native CLI pane ownership changed; input was not replayed')
      }
      let crossedWriteBoundary = false
      if (!pane.ptyId) {
        throw new Error('Native CLI terminal is unverifiable')
      }
      const client = { id: `native-cli:${launchId}`, type: 'desktop' as const }
      if (isTerminalInputLockedForClient(runtime, pane.ptyId, client)) {
        if (isUntypedTerminalInput(text)) {
          return
        }
        throw new Error('Native CLI input is owned by the mobile client')
      }
      if (
        !isUntypedTerminalInput(text) &&
        !(await runtime.refreshRemoteDesktopViewer(
          pane.ptyId,
          client.id,
          binding.cols,
          binding.rows,
          true
        ))
      ) {
        throw new Error('Native CLI input viewport ownership is unavailable')
      }
      try {
        const result = await runtime.sendTerminal(
          pane.handle,
          { text },
          {
            inputKind: 'driving',
            requireWriteSettlement: true,
            reserveWrite: (ptyId) => {
              if (signal?.aborted) {
                throw new Error('Native CLI input detached before delivery')
              }
              const current = runtime.resolveTerminalPane(binding.paneKey, binding.worktreeId)
              if (binding.rotating) {
                throw new NativeCliInputDeferred()
              }
              if (ptyId !== current.ptyId || current.incarnationId !== binding.incarnationId) {
                throw new Error('Native CLI input owner changed')
              }
              crossedWriteBoundary = true
            }
          }
        )
        if (!result.accepted) {
          throw new Error('Native CLI input delivery is unverifiable; no automatic retry was made')
        }
        return
      } catch (error) {
        if (!crossedWriteBoundary && error instanceof NativeCliInputDeferred) {
          continue
        }
        throw error
      }
    }
  }
  const pending = binding.inputTail.then(write)
  binding.inputTail = pending.catch(() => {})
  try {
    await pending
  } finally {
    binding.pendingInputChars -= text.length
  }
}
