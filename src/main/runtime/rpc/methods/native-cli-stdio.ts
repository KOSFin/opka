import { defineMethod, defineStreamingMethod } from '../core'
import { assertNativeCliLocalCaller } from './native-cli-accounts'
import {
  NativeCliStdioStart,
  NativeCliStdioControl,
  NativeCliStdioAttach
} from '../../../../shared/native-cli-stdio'
import {
  startNativeCliStdio,
  requireNativeCliStdioSession,
  retireNativeCliStdioTransport
} from '../../native-cli-stdio-host'

export const NATIVE_CLI_STDIO_METHODS = [
  defineMethod({
    name: 'accounts.startNativeCliStdio',
    permission: 'workspace',
    params: NativeCliStdioStart,
    handler: (params, context) => {
      assertNativeCliLocalCaller(context)
      return startNativeCliStdio(context.runtime, params, context.signal)
    }
  }),
  defineMethod({
    name: 'accounts.controlNativeCliStdio',
    permission: 'workspace',
    params: NativeCliStdioControl,
    handler: async (params, context) => {
      assertNativeCliLocalCaller(context)
      await requireNativeCliStdioSession(
        context.runtime,
        params.launchId,
        params.generation
      ).control(params)
      return { accepted: true }
    }
  }),
  defineStreamingMethod({
    name: 'accounts.attachNativeCliStdio',
    permission: 'workspace',
    params: NativeCliStdioAttach,
    handler: async (params, context, emit) => {
      assertNativeCliLocalCaller(context)
      const session = requireNativeCliStdioSession(
        context.runtime,
        params.launchId,
        params.generation
      )
      if (session.attached) {
        throw new Error('Native CLI stdio already has an output owner.')
      }
      session.attached = true
      let detach = () => {}
      let abort!: () => void
      const aborted = new Promise<void>((resolve) => {
        abort = resolve
      })
      context.signal?.addEventListener('abort', abort, { once: true })
      try {
        detach = session.output.attach(emit)
        if (context.signal?.aborted) {
          abort()
        }
        await Promise.race([session.done, aborted])
      } finally {
        context.signal?.removeEventListener('abort', abort)
        detach()
        if (await session.close()) {
          retireNativeCliStdioTransport(context.runtime, params.launchId)
        }
      }
    }
  })
]
