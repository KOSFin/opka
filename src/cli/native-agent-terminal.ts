import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import type { RuntimeClient } from './runtime-client'
import { streamRuntimeRequest } from './runtime/stream-request'
import { stripElectronRunAsNode } from './runtime/launch'
import { iterateTerminalInputChunks } from '../shared/terminal-input'
import type { NativeCliTerminalCreated } from '../shared/native-cli-terminal'
import type { NativeCodexLaunchContext } from '../shared/native-codex-launch-context'
import { quotePosixShell } from '../shared/shell-argument-quoting'

const Frame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('data'), chunk: z.string() }).passthrough(),
  z
    .object({
      type: z.literal('scrollback'),
      serialized: z.string().optional(),
      lines: z.array(z.string())
    })
    .passthrough(),
  z.object({ type: z.literal('subscribed'), lines: z.array(z.string()) }).passthrough(),
  z
    .object({ type: z.literal('native-cli-pane'), handle: z.string(), incarnationId: z.string() })
    .passthrough(),
  z.object({ type: z.literal('native-cli-exit'), code: z.number().int() }).passthrough()
])

/** An SSH user's terminal drives a dedicated host PTY, never the surrounding login shell. */
export async function runNativeAgentTerminal(
  client: Pick<RuntimeClient, 'call' | 'userDataPath' | 'isRemote'>,
  provider: 'claude' | 'codex',
  executable: string,
  args: string[],
  codexOptions: Partial<NativeCodexLaunchContext> = {}
): Promise<number> {
  const launchId = randomUUID()
  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 })
  const env = Object.fromEntries(
    Object.entries(stripElectronRunAsNode(process.env)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )
  const { result } = await client.call<NativeCliTerminalCreated>(
    'accounts.createNativeCliTerminal',
    {
      launchId,
      provider,
      executable,
      args,
      cwd: process.cwd(),
      env,
      ...size(),
      ...codexOptions
    }
  )
  return attachNativeAgentTerminal(client, result.launchId)
}

export async function attachNativeAgentTerminal(
  client: Pick<RuntimeClient, 'call' | 'userDataPath' | 'isRemote'>,
  launchId: string
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Native terminal attachment requires an interactive TTY; allocate one with ssh -t'
    )
  }
  const result = { launchId }
  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 })
  const controller = new AbortController()
  const wasRaw = process.stdin.isRaw
  const decoder = new StringDecoder('utf8')
  let inputTail = Promise.resolve()
  let inputError: unknown
  let exitCode: number | undefined
  let signalExitCode: number | undefined
  let ready = false
  let incarnationId: string | undefined
  const send = (text: string): void => {
    const sourceIncarnationId = incarnationId
    process.stdin.pause()
    inputTail = inputTail
      .then(async () => {
        if (!sourceIncarnationId) {
          throw new Error('Native CLI input owner is unavailable')
        }
        for (const chunk of iterateTerminalInputChunks(text, 4096)) {
          await client.call(
            'accounts.writeNativeCliTerminal',
            {
              launchId: result.launchId,
              incarnationId: sourceIncarnationId,
              text: chunk
            },
            { signal: controller.signal }
          )
        }
        if (!controller.signal.aborted) {
          process.stdin.resume()
        }
      })
      .catch((error: unknown) => {
        inputError = error
        controller.abort()
      })
  }
  const input = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    if (text) {
      send(text)
    }
  }
  const interrupt = () => send('\x03')
  const detach = () => controller.abort()
  const terminate = () => {
    signalExitCode = 143
    void client
      .call('accounts.stopNativeCliTerminal', { launchId: result.launchId })
      .catch((error: unknown) => {
        inputError = error
        controller.abort()
      })
  }
  const resize = () => {
    void client
      .call(
        'accounts.resizeNativeCliTerminal',
        { launchId: result.launchId, ...size() },
        { signal: controller.signal }
      )
      .catch(() => {})
  }
  const output = async (text: string) => {
    if (!process.stdout.write(text)) {
      await once(process.stdout, 'drain')
    }
  }
  process.stdin.pause()
  process.stdin.setRawMode(true)
  process.stdin.on('data', input)
  process.stdin.once('end', detach)
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  process.on('SIGHUP', detach)
  process.stdout.on('resize', resize)
  try {
    await streamRuntimeRequest(
      client,
      'accounts.attachNativeCliTerminal',
      { launchId: result.launchId, ...size() },
      async (value) => {
        const frame = Frame.safeParse(value)
        if (!frame.success) {
          return
        }
        if (frame.data.type === 'native-cli-pane') {
          incarnationId = frame.data.incarnationId
          ready = true
          process.stdin.pause()
        } else if (frame.data.type === 'scrollback') {
          await output(frame.data.serialized ?? frame.data.lines.join('\r\n'))
          process.stdin.resume()
        } else if (frame.data.type === 'data') {
          await output(frame.data.chunk)
        } else if (frame.data.type === 'subscribed') {
          await output(frame.data.lines.join('\r\n'))
        } else if (frame.data.type === 'native-cli-exit') {
          exitCode = frame.data.code
        }
      },
      controller.signal
    )
    await inputTail
    if (inputError) {
      throw inputError
    }
    if (exitCode === undefined) {
      throw new Error('Native CLI exit is unverifiable; no process was stopped')
    }
    return signalExitCode ?? exitCode
  } catch (error) {
    if (!ready && !inputError) {
      throw error
    }
    const command = quotePosixShell(
      process.env.ORCA_NATIVE_CLI_LAUNCHER ?? process.env.ORCA_CLI_COMMAND ?? 'orca-ide'
    )
    throw new Error(
      `Native CLI terminal detached; execution is unverifiable. Reattach with ${command} agent native-attach ${launchId}`,
      {
        cause: inputError ?? error
      }
    )
  } finally {
    controller.abort()
    process.stdin.pause()
    process.stdin.off('data', input)
    process.stdin.off('end', detach)
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
    process.off('SIGHUP', detach)
    process.stdout.off('resize', resize)
    process.stdin.setRawMode(wasRaw)
  }
}
