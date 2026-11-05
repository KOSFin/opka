import { createServer } from 'node:http'
import {
  NativeClaudeCoverageParams,
  type NativeClaudeCoverageRequest,
  type NativeClaudeCoverageAck
} from '../../shared/native-claude-coverage'
import { writeClaudeNativeToolProbeResponse } from './claude-native-tool-probe-response'

export function createClaudeNativePrintGatewayEndpoint(options: {
  capability: string
  readAccountUuid: (id: string) => string | undefined
  observe: (request: NativeClaudeCoverageRequest) => Promise<NativeClaudeCoverageAck>
}) {
  const observed: { kind: string; healthy: boolean }[] = []
  const provider: {
    account: string
    identity: boolean
    originalCount: number
    toolResult: boolean
    localCapabilityLeaked: boolean
  }[] = []
  const usage: { account: string }[] = []
  let healthy = true
  const endpoint = createServer(async (request, response) => {
    try {
      let raw = ''
      for await (const chunk of request) {
        raw += chunk
        if (raw.length > 2 * 1024 * 1024) {
          throw new Error('Fixture byte budget.')
        }
      }
      if (request.url === '/coverage') {
        const parsed = NativeClaudeCoverageParams.parse(JSON.parse(raw))
        const result = await options.observe(parsed)
        healthy &&= result.healthy
        observed.push({ kind: parsed.observation.kind, healthy: result.healthy })
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
        return
      }
      if (request.url === '/api/oauth/usage') {
        const account =
          request.headers.authorization === 'Bearer sk-ant-oat01-synthetic-wrapper-A'
            ? 'A'
            : 'unknown'
        usage.push({ account })
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            five_hour: {
              utilization: account === 'A' ? 100 : 0,
              resets_at: new Date(Date.now() + 60_000).toISOString()
            }
          })
        )
        return
      }
      if (request.url?.startsWith('/v1/messages')) {
        const body = JSON.parse(raw)
        if (body.model !== 'claude-sonnet-4-5') {
          writeClaudeNativeToolProbeResponse(response, body.model, [])
          return
        }
        const account =
          ['A', 'B', 'C'].find(
            (id) => request.headers.authorization === `Bearer sk-ant-oat01-synthetic-wrapper-${id}`
          ) ?? 'unknown'
        const messages = JSON.stringify(body.messages)
        if (provider.length >= 12) {
          throw new Error('Fixture attempt budget.')
        }
        provider.push({
          account,
          identity:
            JSON.parse(body.metadata.user_id).account_uuid === options.readAccountUuid(account),
          originalCount: (messages.match(/synthetic-print-gateway-original/g) ?? []).length,
          toolResult: messages.includes('synthetic-gateway-tool-result'),
          localCapabilityLeaked: request.headers.authorization === `Bearer ${options.capability}`
        })
        if (account === 'A' && provider.length > 1) {
          response
            .writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' })
            .end('{"error":{"type":"rate_limit_error","message":"Synthetic subscription limit"}}')
          return
        }
        writeClaudeNativeToolProbeResponse(
          response,
          body.model,
          provider.length === 1
            ? [
                {
                  type: 'tool_use',
                  id: 'toolu_native_gateway',
                  name: 'Bash',
                  input: {
                    command: 'printf synthetic-gateway-tool-result',
                    description: 'Isolated fixed fixture'
                  }
                }
              ]
            : []
        )
        return
      }
      response.writeHead(404).end('{}')
    } catch {
      healthy = false
      response.writeHead(503).end('{}')
    }
  })
  return { endpoint, observed, provider, usage, healthy: () => healthy }
}
