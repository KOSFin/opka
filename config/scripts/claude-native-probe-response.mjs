import { randomUUID } from 'node:crypto'
export function writeSyntheticClaudeResponse(res, parsed, authenticationFailure = false) {
  if (res.destroyed || res.writableEnded) {
    return
  }
  if (authenticationFailure) {
    res.writeHead(401, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'synthetic expired account request' }
      })
    )
    return
  }
  const message = {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: parsed.model,
    content: [{ type: 'text', text: 'synthetic-response' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }
  }
  if (!parsed.stream) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const event = (data) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
  event({
    type: 'message_start',
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 0 }
    }
  })
  event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  event({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'synthetic-response' }
  })
  event({ type: 'content_block_stop', index: 0 })
  event({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 }
  })
  event({ type: 'message_stop' })
  res.end()
}
