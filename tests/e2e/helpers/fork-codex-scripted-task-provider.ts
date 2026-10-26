import { createServer } from 'node:http'
import { z } from 'zod'

const Tool = z.object({ type: z.string(), name: z.string().optional() }).passthrough()
const Request = z.object({ tools: z.array(Tool).optional() }).passthrough()
const event = (payload: Record<string, unknown>) =>
  `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`

/** Local scripted Responses, not inference; the actual Codex must execute the tool itself. */
export async function startForkCodexScriptedTaskProvider(command: string) {
  let requests = 0
  const tools = new Set<string>()
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 4 * 1024 * 1024) {
        request.destroy()
      } else {
        chunks.push(chunk)
      }
    })
    request.on('end', () => {
      try {
        const body = Request.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        for (const tool of body.tools ?? []) {
          if (tool.name) {
            tools.add(tool.name)
          }
        }
        requests += 1
        if (requests > 3) {
          response.writeHead(500).end()
          return
        }
        const item =
          requests === 1
            ? {
                type: 'function_call',
                id: 'fc_scripted_task',
                call_id: 'call_scripted_task',
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: command, max_output_tokens: 2000 })
              }
            : {
                type: 'message',
                role: 'assistant',
                id: 'msg_scripted_task',
                content: [{ type: 'output_text', text: 'Scripted local transport complete.' }]
              }
        const id = `resp_scripted_${requests}`
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          event({ type: 'response.created', response: { id } }) +
            event({ type: 'response.output_item.done', output_index: 0, item }) +
            event({ type: 'response.completed', response: { id, output: [item] } })
        )
      } catch {
        response.writeHead(400).end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('No scripted provider port')
  }
  return {
    selection: 'model="scripted-task"\nmodel_provider="opka_scripted"\n',
    config: `[model_providers.opka_scripted]\nname="Opka local scripted test"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`,
    receipt: () => ({ requests, tools: [...tools] }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
