import { defineMethod, defineStreamingMethod } from '../core'
import { assertNativeCliLocalCaller } from './native-cli-accounts'
import {
  NativeCliTerminalCreate,
  NativeCliTerminalInput,
  NativeCliTerminalResize,
  NativeCliTerminalReference
} from '../../../../shared/native-cli-terminal'
import { createNativeCliTerminal } from '../../native-cli-terminal-create'
import { writeNativeCliTerminalInput } from '../../native-cli-terminal-input'
import { streamNativeCliTerminal } from '../../native-cli-terminal-stream'
import {
  nativeCliTerminalBindings,
  waitForNativeCliTerminalRotation
} from '../../native-cli-terminal-bindings'

export const NATIVE_CLI_TERMINAL_METHODS = [
  defineMethod({
    name: 'accounts.stopNativeCliTerminal',
    permission: 'workspace',
    params: NativeCliTerminalReference,
    handler: async ({ launchId }, context) => {
      assertNativeCliLocalCaller(context)
      const binding = nativeCliTerminalBindings(context.runtime).get(launchId)
      if (!binding) {
        throw new Error('Native CLI terminal ownership is unavailable')
      }
      await waitForNativeCliTerminalRotation(binding, context.signal)
      const pane = context.runtime.resolveTerminalPane(binding.paneKey, binding.worktreeId)
      if (!pane.ptyId || pane.incarnationId !== binding.incarnationId) {
        throw new Error('Native CLI terminal ownership changed')
      }
      const stop = await context.runtime.stopExactTerminalsForWorktree(
        `id:${binding.worktreeId}`,
        [pane.ptyId],
        {
          targetOnly: true,
          keepHistory: true,
          expectedIncarnationId: binding.incarnationId
        }
      )
      if (!stop.postStopVerified) {
        throw new Error('Native CLI exit is unverifiable')
      }
      return { stopped: true }
    }
  }),
  defineMethod({
    name: 'accounts.createNativeCliTerminal',
    permission: 'workspace',
    params: NativeCliTerminalCreate,
    handler: async (params, context) => {
      assertNativeCliLocalCaller(context)
      return createNativeCliTerminal(context.runtime, params, context.signal)
    }
  }),
  defineStreamingMethod({
    name: 'accounts.attachNativeCliTerminal',
    permission: 'workspace',
    params: NativeCliTerminalResize,
    handler: async (params, context, emit) => {
      assertNativeCliLocalCaller(context)
      await streamNativeCliTerminal(context, params, emit)
    }
  }),
  defineMethod({
    name: 'accounts.writeNativeCliTerminal',
    permission: 'workspace',
    params: NativeCliTerminalInput,
    handler: async ({ launchId, text, incarnationId }, context) => {
      assertNativeCliLocalCaller(context)
      await writeNativeCliTerminalInput(
        context.runtime,
        launchId,
        text,
        incarnationId,
        context.signal
      )
      return { accepted: true }
    }
  }),
  defineMethod({
    name: 'accounts.resizeNativeCliTerminal',
    permission: 'workspace',
    params: NativeCliTerminalResize,
    handler: async (params, context) => {
      assertNativeCliLocalCaller(context)
      const binding = nativeCliTerminalBindings(context.runtime).get(params.launchId)
      if (!binding) {
        throw new Error('Native CLI terminal ownership is unavailable')
      }
      binding.cols = params.cols
      binding.rows = params.rows
      await waitForNativeCliTerminalRotation(binding, context.signal)
      const pane = context.runtime.resolveTerminalPane(binding.paneKey, binding.worktreeId)
      if (!pane.ptyId || pane.incarnationId !== binding.incarnationId) {
        throw new Error('Native CLI terminal is unverifiable')
      }
      await context.runtime.refreshRemoteDesktopViewer(
        pane.ptyId,
        `native-cli:${params.launchId}`,
        params.cols,
        params.rows,
        true
      )
      return { resized: true }
    }
  })
]
