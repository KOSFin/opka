import { createOutputSink } from '@orca/process-host/bounded-output-sink'

export async function readNativeClaudeHookInput(
  stdin: AsyncIterable<Buffer | string>,
  limit: number,
  signal?: AbortSignal
): Promise<unknown> {
  const output = createOutputSink(limit)
  for await (const chunk of stdin) {
    if (signal?.aborted) {
      throw new Error('Native hook input was stopped.')
    }
    output.write(chunk)
    if (output.truncated()) {
      throw new Error('Native hook input exceeds the bounded reader.')
    }
  }
  return JSON.parse(output.text())
}
