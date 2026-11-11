import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { SYNTHETIC_COMPACTION_CIPHERTEXT } from './codex-native-probe-ciphertext.mjs'

export function createSyntheticRoutingUpstream({
  requests,
  nativeAuthSwap,
  getEngine,
  getAccount
}) {
  const compactOutput = { type: 'compaction', encrypted_content: SYNTHETIC_COMPACTION_CIPHERTEXT }
  let compactResponseSha256
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({ data: ['probe-a', 'probe-b'].map((id) => ({ id, object: 'model' })) })
        )
        return
      }
      const remoteCompact = request.url === '/v1/responses/compact'
      if (request.method !== 'POST' || (!remoteCompact && request.url !== '/v1/responses')) {
        response.writeHead(404).end()
        return
      }
      let body = ''
      for await (const chunk of request) {
        body += chunk
        if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
          throw new Error('Synthetic input exceeded limit')
        }
      }
      const input = JSON.parse(body)
      const metadata = request.headers['x-codex-turn-metadata']
      const triggerCount = Array.isArray(input.input)
        ? input.input.filter((item) => item?.type === 'compaction_trigger').length
        : 0
      const remoteV2Compact = request.url === '/v1/responses' && triggerCount > 0
      const compactionRequest =
        remoteCompact ||
        remoteV2Compact ||
        (typeof metadata === 'string' && JSON.parse(metadata).request_kind === 'compaction')
      const routedAccount =
        getEngine() || nativeAuthSwap
          ? request.headers.authorization?.replace('Bearer ', '')
          : getAccount()
      const text = compactionRequest
        ? 'SYNTHETIC_COMPACTED_CONTEXT'
        : routedAccount === 'synthetic-A'
          ? 'PROBE_A'
          : 'PROBE_B'
      const compactItems = Array.isArray(input.input)
        ? input.input.filter((item) => item?.type === 'compaction')
        : []
      const compactItem = compactItems.length === 1 ? compactItems[0] : undefined
      const compactCiphertext =
        typeof compactItem?.encrypted_content === 'string'
          ? compactItem.encrypted_content
          : undefined
      const compactKnownKeys = [
        'encrypted_content',
        'id',
        'internal_chat_message_metadata_passthrough',
        'type'
      ]
      requests.push({
        account: routedAccount,
        model: input.model,
        kind: remoteV2Compact
          ? 'remote-v2-compact'
          : remoteCompact
            ? 'remote-compact'
            : compactionRequest
              ? 'local-compact'
              : 'turn',
        bodyBytes: Buffer.byteLength(body),
        bodySha256: createHash('sha256').update(body).digest('hex'),
        triggerCount,
        opaqueCompactItemCount: compactItems.length,
        opaqueCiphertextMatches: compactCiphertext === SYNTHETIC_COMPACTION_CIPHERTEXT,
        opaqueCiphertextSha256: compactCiphertext
          ? createHash('sha256').update(compactCiphertext).digest('hex')
          : undefined,
        opaqueCiphertextBytes: compactCiphertext ? Buffer.byteLength(compactCiphertext) : undefined,
        opaqueCompactKnownKeys: compactItem
          ? Object.keys(compactItem)
              .filter((key) => compactKnownKeys.includes(key))
              .sort()
          : [],
        opaqueCompactUnknownKeyCount: compactItem
          ? Object.keys(compactItem).filter((key) => !compactKnownKeys.includes(key)).length
          : 0,
        opaqueCompactInInput:
          compactItems.length === 1 &&
          compactItems[0].encrypted_content === SYNTHETIC_COMPACTION_CIPHERTEXT &&
          Object.keys(compactItems[0]).every(
            (key) =>
              Object.hasOwn(compactOutput, key) ||
              (key === 'id' &&
                typeof compactItems[0].id === 'string' &&
                compactItems[0].id.length > 0)
          ),
        localCompactInInput: JSON.stringify(input.input ?? []).includes(
          'SYNTHETIC_COMPACTED_CONTEXT'
        ),
        previousResponseIdPresent: typeof input.previous_response_id === 'string',
        priorReplyInInput:
          Array.isArray(input.input) &&
          input.input.some(
            (item) =>
              item.role === 'assistant' &&
              Array.isArray(item.content) &&
              item.content.some((part) => part.text === 'PROBE_A')
          ),
        secondReplyInInput:
          Array.isArray(input.input) &&
          input.input.some(
            (item) =>
              item.role === 'assistant' &&
              Array.isArray(item.content) &&
              item.content.some((part) => part.text === 'PROBE_B')
          ),
        stream: input.stream
      })
      if (remoteCompact) {
        const compactResponse = JSON.stringify({
          id: 'cmp_synthetic',
          object: 'response.compaction',
          created_at: 1,
          output: [compactOutput]
        })
        compactResponseSha256 = createHash('sha256').update(compactResponse).digest('hex')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(compactResponse)
        return
      }
      const id = `resp_probe_${requests.length}`
      const item = remoteV2Compact
        ? compactOutput
        : {
            id: `msg_probe_${requests.length}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }]
          }
      const complete = {
        id,
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: input.model,
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const events = [
        ['response.created', { response: { ...complete, status: 'in_progress', output: [] } }],
        [
          'response.output_item.added',
          {
            output_index: 0,
            item: remoteV2Compact ? item : { ...item, status: 'in_progress', content: [] }
          }
        ],
        ...(!remoteV2Compact
          ? [
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
              [
                'response.output_text.done',
                { output_index: 0, item_id: item.id, content_index: 0, text }
              ],
              [
                'response.content_part.done',
                { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] }
              ]
            ]
          : []),
        ['response.output_item.done', { output_index: 0, item }],
        ['response.completed', { response: complete }]
      ]
      const eventBytes = events
        .map(
          ([type, payload], sequence_number) =>
            `event: ${String(type)}\ndata: ${JSON.stringify({ type, sequence_number, ...payload })}\n\n`
        )
        .join('')
      if (remoteV2Compact) {
        compactResponseSha256 = createHash('sha256').update(eventBytes).digest('hex')
      }
      response.end(eventBytes)
    } catch {
      if (!response.headersSent) {
        response.writeHead(400)
      }
      response.end()
    }
  })
  return { server, completeResponseSha256: () => compactResponseSha256 }
}
