import {
  NativeClaudeCoverageParams,
  NativeClaudeCoverageResult
} from '../shared/native-claude-coverage'
import { NATIVE_CLAUDE_ROUTING_KEY_ENV } from '../shared/native-claude-hook'
import type { RuntimeClient } from './runtime-client'
import { readNativeClaudeHookInput } from './native-claude-hook-input'

type Io = {
  stdin: AsyncIterable<Buffer | string>
  env: NodeJS.ProcessEnv
  stdout: (text: string) => void
  stderr: (text: string) => void
  signal?: AbortSignal
}

/** Only bounded native identity/lifecycle metadata crosses this private command. */
export async function runNativeClaudeCoverage(
  client: Pick<RuntimeClient, 'call'>,
  args: string[],
  io: Io = {
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
    if (args.length !== 1) {
      throw new Error('Invalid native continuity command.')
    }
    const body = await readNativeClaudeHookInput(io.stdin, 256 * 1024, io.signal)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Invalid native continuity input.')
    }
    const request = NativeClaudeCoverageParams.parse({
      ...body,
      launchId: args[0],
      capability: io.env[NATIVE_CLAUDE_ROUTING_KEY_ENV]
    })
    const response = await client.call<unknown>('accounts.nativeClaudeCoverage', request, {
      timeoutMs: 55000,
      signal: io.signal
    })
    const ack = NativeClaudeCoverageResult.parse(response.result)
    if (ack.sequence !== request.sequence) {
      throw new Error('Native continuity acknowledgement changed.')
    }
    io.stdout(JSON.stringify(ack))
    return 0
  } catch {
    io.stderr('Managed Claude continuity is unavailable; reconnect or restart this session.\n')
    return 1
  }
}
