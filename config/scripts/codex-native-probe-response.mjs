import {
  SYNTHETIC_REASONING_CIPHERTEXT,
  SYNTHETIC_COMPACTION_CIPHERTEXT
} from './codex-native-probe-ciphertext.mjs'
export function writeNativeProbeResponse(
  res,
  body,
  account,
  index,
  toolCall = false,
  encrypted = false,
  compact = false,
  approval = false
) {
  const text = compact
    ? 'SYNTHETIC_COMPACTED_CONTEXT'
    : account === 'synthetic-A'
      ? 'SYNTHETIC_A_MARKER'
      : 'SYNTHETIC_B_MARKER'
  const includeReasoning = encrypted && !compact
  const item = compact
    ? { id: `cmp_${index}`, type: 'compaction', encrypted_content: SYNTHETIC_COMPACTION_CIPHERTEXT }
    : toolCall
      ? {
          id: `fc_${index}`,
          type: 'function_call',
          call_id: 'synthetic_exec_1',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: 'printf SYNTHETIC_TOOL_EXECUTED',
            yield_time_ms: 1000,
            max_output_tokens: 100,
            ...(approval
              ? {
                  sandbox_permissions: 'require_escalated',
                  justification: 'Synthetic fixed local printf qualification'
                }
              : {})
          }),
          status: 'completed'
        }
      : {
          id: `msg_${index}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }]
        }
  const reasoning = {
    id: `reasoning_${index}`,
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'Synthetic retained reasoning.' }],
    encrypted_content: SYNTHETIC_REASONING_CIPHERTEXT
  }
  const complete = {
    id: `resp_${index}`,
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: body.model,
    output: includeReasoning ? [reasoning, item] : [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const events = [
    ['response.created', { response: { ...complete, status: 'in_progress', output: [] } }],
    [
      'response.output_item.added',
      {
        output_index: 0,
        item: toolCall
          ? { ...item, status: 'in_progress', arguments: '' }
          : { ...item, status: 'in_progress', content: [] }
      }
    ],
    [
      'response.content_part.added',
      {
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      }
    ],
    [
      'response.output_text.delta',
      { output_index: 0, item_id: item.id, content_index: 0, delta: text }
    ],
    ['response.output_item.done', { output_index: 0, item }],
    ['response.completed', { response: complete }]
  ]
  if (compact) {
    events.splice(1, events.length - 2, ['response.output_item.done', { output_index: 0, item }])
  }
  if (includeReasoning) {
    events.splice(
      1,
      0,
      [
        'response.output_item.added',
        { output_index: 0, item: { ...reasoning, summary: [], encrypted_content: null } }
      ],
      ['response.output_item.done', { output_index: 0, item: reasoning }]
    )
    for (const [, payload] of events.slice(3)) {
      if ('output_index' in payload) {
        payload.output_index = 1
      }
    }
  }
  if (toolCall) {
    events.splice(
      2,
      2,
      [
        'response.function_call_arguments.delta',
        { output_index: 0, item_id: item.id, delta: item.arguments }
      ],
      [
        'response.function_call_arguments.done',
        { output_index: 0, item_id: item.id, arguments: item.arguments }
      ]
    )
  }
  for (const [index, [type, value]] of events.entries()) {
    res.write(
      `event: ${String(type)}\ndata: ${JSON.stringify({ type, sequence_number: index, ...value })}\n\n`
    )
  }
  res.end()
}

export function writeNativeProbePartialResponse(res, body, report) {
  const item = {
    id: 'msg_partial',
    type: 'message',
    role: 'assistant',
    status: 'in_progress',
    content: []
  }
  const events = [
    [
      'response.created',
      {
        response: {
          id: 'resp_partial',
          object: 'response',
          status: 'in_progress',
          model: body.model,
          output: []
        }
      }
    ],
    ['response.output_item.added', { output_index: 0, item }],
    [
      'response.content_part.added',
      {
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      }
    ],
    [
      'response.output_text.delta',
      { output_index: 0, item_id: item.id, content_index: 0, delta: 'SYNTHETIC_PARTIAL' }
    ]
  ]
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const [index, [type, value]] of events.entries()) {
    res.write(
      `event: ${String(type)}\ndata: ${JSON.stringify({ type, sequence_number: index, ...value })}\n\n`
    )
  }
  res.on('close', () => {
    report.nativeUpstreamCancelled = true
  })
}
