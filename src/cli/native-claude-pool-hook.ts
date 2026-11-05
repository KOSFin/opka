import { z } from 'zod'
import { readNativeClaudeHookInput } from './native-claude-hook-input'
import type { RuntimeClient } from './runtime-client'
import {
  NativeClaudeHookParams,
  NativeClaudeHookResult,
  NATIVE_CLAUDE_ROUTING_KEY_ENV,
  type NativeClaudeHookRequest
} from '../shared/native-claude-hook'

const HookInput = z.object({
  session_id: z.string().min(1).max(256),
  prompt_id: z.string().min(1).max(256),
  agent_id: z.string().optional(),
  prompt: z.string().optional(),
  error: z.string().optional()
})
const Actions = z.enum(['prompt', 'failure', 'stop', 'fresh-wake'])
type HookIo = {
  stdin: AsyncIterable<Buffer | string>
  env: NodeJS.ProcessEnv
  stdout: (value: string) => void
  stderr: (value: string) => void
  signal?: AbortSignal
}

/** Original prompts stay in the native process; RPC carries only identity and a wake marker. */
export async function runNativeClaudePoolHook(
  client: Pick<RuntimeClient, 'call'>,
  argv: string[],
  io: HookIo = {
    stdin: process.stdin,
    env: process.env,
    stdout: (text) => {
      process.stdout.write(text)
    },
    stderr: (text) => {
      process.stderr.write(text)
    }
  }
): Promise<number> {
  try {
    const [launchId, rawAction] = argv
    if (argv.length !== 2) {
      throw new Error('Invalid native hook command')
    }
    const action = Actions.parse(rawAction)
    const input = HookInput.parse(
      await readNativeClaudeHookInput(io.stdin, 8 * 1024 * 1024, io.signal)
    )
    if (input.agent_id || (action === 'failure' && input.error !== 'rate_limit')) {
      return 0
    }
    const markers = input.prompt?.match(/<opka-native-wake:v1:[a-f0-9-]{36}:[12]:[a-f0-9]{64}>/g)
    const wakeMarker = markers?.length === 1 ? markers[0] : undefined
    const common = {
      launchId,
      capability: io.env[NATIVE_CLAUDE_ROUTING_KEY_ENV],
      sessionId: input.session_id,
      promptId: input.prompt_id
    }
    let params: NativeClaudeHookRequest
    if (action === 'failure') {
      params = NativeClaudeHookParams.parse({ ...common, event: action, error: 'rate_limit' })
    } else if (action === 'prompt' || action === 'fresh-wake') {
      params = NativeClaudeHookParams.parse({ ...common, event: action, wakeMarker })
    } else {
      params = NativeClaudeHookParams.parse({ ...common, event: action })
    }
    const call = async (request: NativeClaudeHookRequest) =>
      NativeClaudeHookResult.parse(
        (
          await client.call<unknown>('accounts.nativeClaudeHook', request, {
            timeoutMs: 55_000,
            signal: io.signal
          })
        ).result
      )
    let result = await call(params)
    if (result.action === 'prepared') {
      result = await call(
        NativeClaudeHookParams.parse({
          ...common,
          event: 'claim-wake',
          phaseId: result.phaseId,
          step: 1
        })
      )
    }
    if (io.signal?.aborted) {
      return 1
    }
    if (result.action === 'wake') {
      io.stderr(`Continue the interrupted task.\n${result.marker}`)
      return 2
    }
    if (result.action === 'block') {
      io.stdout(
        JSON.stringify({
          decision: 'block',
          reason: 'Preparing a fresh native account context.',
          hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true }
        })
      )
    }
    return 0
  } catch {
    if (io.signal?.aborted) {
      return 1
    }
    if (argv[1] === 'prompt') {
      io.stdout(
        JSON.stringify({
          decision: 'block',
          reason: 'Account host unavailable; reconnect or restart this native session.'
        })
      )
      return 0
    }
    io.stderr('Managed Claude account preparation is unavailable.\n')
    return 1
  }
}
