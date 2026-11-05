import type { ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

export function writeClaudeNativeToolProbeResponse(
  response: ServerResponse,
  model: string,
  content: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }[]
) {
  if (response.destroyed || response.writableEnded) {
    return
  }
  const blocks = content.length ? content : [{ type: 'text', text: 'synthetic-response' }]
  const event = (data: { type: string } & Record<string, unknown>) =>
    response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  event({
    type: 'message_start',
    message: {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 0 }
    }
  })
  for (const [index, block] of blocks.entries()) {
    if ('input' in block) {
      event({ type: 'content_block_start', index, content_block: { ...block, input: {} } })
      event({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      })
    } else {
      event({ type: 'content_block_start', index, content_block: { ...block, text: '' } })
      event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
    }
    event({ type: 'content_block_stop', index })
  }
  event({
    type: 'message_delta',
    delta: { stop_reason: content.length ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 }
  })
  event({ type: 'message_stop' })
  response.end()
}
