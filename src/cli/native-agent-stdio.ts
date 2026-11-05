import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import type { EventEmitter } from 'node:events'
import { watchNativeAgentStdioErrors } from './native-agent-stdio-stream-errors'
import type { RuntimeClient } from './runtime-client'
import { streamRuntimeRequest } from './runtime/stream-request'
import { stripElectronRunAsNode } from './runtime/launch'
import { NativeCliStdioFrame, type NativeCliStdioCreated } from '../shared/native-cli-stdio'

const write = (output: Writable, bytes: Buffer) =>
  new Promise<void>((resolve, reject) =>
    output.write(bytes, (error) =>
      error ? reject(new Error('Native CLI local output stream failed.')) : resolve()
    )
  )

/** Native print-mode bytes keep their channels, EOF and exit code; no PTY or transcript parser. */
export async function runNativeAgentStdio(
  client: Pick<RuntimeClient, 'call' | 'userDataPath' | 'isRemote'>,
  executable: string,
  args: string[],
  io: {
    stdin: Readable
    stdout: Writable
    stderr: Writable
    signals: Pick<EventEmitter, 'on' | 'removeListener'>
  } = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signals: process }
): Promise<number> {
  if (client.isRemote || process.platform === 'win32') {
    throw new Error('Native stdio attachment must run on its qualified execution host.')
  }
  const controller = new AbortController()
  let inputError: unknown
  const pendingWrites = new Set<Promise<void>>()
  const stopWatchingErrors = watchNativeAgentStdioErrors([io.stdin, io.stdout, io.stderr], () => {
    inputError = new Error('Native CLI local input/output stream failed.')
    controller.abort()
  })
  try {
    const env = Object.fromEntries(
      Object.entries(stripElectronRunAsNode(process.env)).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    const { result } = await client.call<NativeCliStdioCreated>(
      'accounts.startNativeCliStdio',
      {
        launchId: randomUUID(),
        executable,
        args,
        cwd: process.cwd(),
        env
      },
      { signal: controller.signal }
    )
    let sequence = 0
    let inputSequence = 0
    let inputPending = Promise.resolve()
    let readTail = Promise.resolve()
    let code: number | undefined
    let signalForwarded = false
    const input = (action: {
      input?: string
      eof?: true
      signal?: 'SIGINT' | 'SIGTERM' | 'SIGHUP'
    }) => {
      const next = ++inputSequence
      inputPending = inputPending
        .then(async () => {
          await client.call(
            'accounts.controlNativeCliStdio',
            {
              ...result,
              sequence,
              inputSequence: next,
              ...action
            },
            { signal: controller.signal }
          )
        })
        .catch((error: unknown) => {
          inputError = error
          controller.abort()
        })
      return inputPending
    }
    const receive = (chunk: Buffer | string) => {
      io.stdin.pause()
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      readTail = readTail
        .then(async () => {
          for (
            let offset = 0;
            offset < bytes.length && !controller.signal.aborted;
            offset += 32 * 1024
          ) {
            await input({ input: bytes.subarray(offset, offset + 32 * 1024).toString('base64') })
          }
          if (!controller.signal.aborted) {
            io.stdin.resume()
          }
        })
        .catch((error: unknown) => {
          inputError = error
          controller.abort()
        })
    }
    const eof = () => {
      void readTail.then(() => {
        if (!controller.signal.aborted) {
          return input({ eof: true })
        }
        return undefined
      })
    }
    const signal = (name: 'SIGINT' | 'SIGTERM' | 'SIGHUP') => {
      if (signalForwarded) {
        controller.abort()
        return
      }
      signalForwarded = true
      void client
        .call(
          'accounts.controlNativeCliStdio',
          {
            ...result,
            sequence,
            signal: name
          },
          { signal: controller.signal }
        )
        .catch((error: unknown) => {
          inputError = error
          controller.abort()
        })
    }
    const sigint = () => signal('SIGINT')
    const sigterm = () => signal('SIGTERM')
    const sighup = () => signal('SIGHUP')
    io.stdin.on('data', receive)
    io.stdin.once('end', eof)
    io.signals.on('SIGINT', sigint)
    io.signals.on('SIGTERM', sigterm)
    io.signals.on('SIGHUP', sighup)
    try {
      if (io.stdin.readableEnded) {
        eof()
      } else {
        io.stdin.resume()
      }
      await streamRuntimeRequest(
        client,
        'accounts.attachNativeCliStdio',
        result,
        async (raw) => {
          const event = NativeCliStdioFrame.parse(raw)
          if (event.type === 'native-stdio-exit') {
            code = event.code
            return
          }
          if (event.sequence !== sequence + 1) {
            throw new Error('Native CLI output sequence changed.')
          }
          const writing = write(
            event.channel === 'stdout' ? io.stdout : io.stderr,
            Buffer.from(event.bytes, 'base64')
          )
          pendingWrites.add(writing)
          void writing.then(
            () => pendingWrites.delete(writing),
            () => pendingWrites.delete(writing)
          )
          await writing
          sequence = event.sequence
          await client.call(
            'accounts.controlNativeCliStdio',
            { ...result, sequence },
            { signal: controller.signal }
          )
        },
        controller.signal,
        { pauseTimeoutWhileConsuming: true }
      )
      if (inputError) {
        throw inputError
      }
      if (code === undefined) {
        throw new Error('Native CLI exit remains unverifiable.')
      }
      return code
    } finally {
      controller.abort()
      io.stdin.pause()
      io.stdin.removeListener('data', receive)
      io.stdin.removeListener('end', eof)
      io.signals.removeListener('SIGINT', sigint)
      io.signals.removeListener('SIGTERM', sigterm)
      io.signals.removeListener('SIGHUP', sighup)
    }
  } catch (error) {
    throw inputError ?? error
  } finally {
    controller.abort()
    stopWatchingErrors(Promise.allSettled(pendingWrites))
  }
}
