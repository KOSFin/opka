import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'

const privateHeaders = new Set([
  'authorization',
  'proxy-authorization',
  'host',
  'cookie',
  'set-cookie',
  'chatgpt-account-id',
  'openai-organization',
  'openai-project',
  'x-codex-routing-hint',
  'x-codex-turn-state'
])
const hopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length'
]

/** Native turn/tool metadata survives; account credentials and sticky hints never cross accounts. */
export function codexRoutingHeaders(source: IncomingHttpHeaders): OutgoingHttpHeaders {
  const excluded = new Set([...privateHeaders, ...hopHeaders])
  for (const name of source.connection?.split(',') ?? []) {
    excluded.add(name.trim().toLowerCase())
  }
  const result: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !excluded.has(key.toLowerCase())) {
      result[key] = value
    }
  }
  return result
}
