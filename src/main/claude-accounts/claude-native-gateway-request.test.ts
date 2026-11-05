import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  claudeNativeGatewayHeaders,
  readClaudeNativeGatewayRequest
} from './claude-native-gateway-request'

const account = randomUUID(),
  replacement = randomUUID(),
  session = randomUUID()
const metadata = JSON.stringify({
  device_id: 'opaque-native-device',
  account_uuid: account,
  session_id: session,
  extra: { untouched: true }
})
const request = (extra = '') =>
  Buffer.from(
    `{ "model":"native-model", "messages":[{"role":"user","content":"Unicode 日本語"}],"metadata":{"user_id":${JSON.stringify(metadata)}}${extra} }`
  )

it('changes only the exact metadata string span while preserving native model, tools and wire bytes', () => {
  const raw = request(',"tools":[{"name":"native_tool","input_schema":{"type":"object"}}]')
  const parsed = readClaudeNativeGatewayRequest(raw, account)
  expect(parsed).toMatchObject({ model: 'native-model', sessionId: session, messageCount: 1 })
  const changed = parsed.forAccount(replacement)
  expect(changed.equals(Buffer.from(raw.toString().replace(account, replacement)))).toBe(true)
  expect(parsed.forAccount(account)).toEqual(raw)
})

it('preserves native child and parent session identifiers during account replacement', () => {
  const childMetadata = JSON.stringify({
    account_uuid: account,
    session_id: 'native_child_123',
    parent_session_id: session
  })
  const raw = Buffer.from(
    request().toString().replace(JSON.stringify(metadata), JSON.stringify(childMetadata))
  )
  const parsed = readClaudeNativeGatewayRequest(raw, account)
  expect(parsed).toMatchObject({ sessionId: 'native_child_123', parentSessionId: session })
  expect(parsed.forAccount(replacement)).toEqual(
    Buffer.from(raw.toString().replace(account, replacement))
  )
})

it.each([
  () => request(',"model":"duplicate"'),
  () => request(',"container":"server-owned"'),
  () => request(',"container":[]'),
  () => request(',"container":{}'),
  () => Buffer.from(request().toString().replace(account, randomUUID())),
  () =>
    Buffer.from(request().toString().replace(JSON.stringify(metadata), JSON.stringify('not JSON'))),
  () =>
    Buffer.from(request().toString().replace('"metadata":{', '"metadata":{"user_id":"duplicate",')),
  () => Buffer.from(`${request().toString()}{}`),
  () =>
    Buffer.from(request().toString().replace('"messages":[', '"messages":[/* not native JSON */')),
  () => request(`,"deep":${'['.repeat(65)}0${']'.repeat(65)}`),
  () => Buffer.from([255])
])('refuses ambiguous, invalid or unqualified identity/state without exposing payloads', (make) => {
  expect(() => readClaudeNativeGatewayRequest(make(), account)).toThrow()
})

it('does not materialize a large native attachment tree', () => {
  const raw = request(`,"attachment":{"data":"${'x'.repeat(1024 * 1024)}"}`)
  expect(readClaudeNativeGatewayRequest(raw, account).forAccount(replacement).length).toBe(
    raw.length
  )
})

it('strips all caller credentials and unqualified identity headers while preserving native protocol flags', () => {
  expect(
    claudeNativeGatewayHeaders(
      {
        authorization: 'local-cap',
        'x-api-key': 'other-key',
        cookie: 'private',
        'x-organization-uuid': account,
        'anthropic-organization-id': account,
        'anthropic-beta': 'native-feature',
        'x-stainless-lang': 'js',
        'x-client-request-id': 'native-request',
        connection: 'private-connection'
      },
      'source-token'
    )
  ).toEqual({
    authorization: 'Bearer source-token',
    'content-type': 'application/json',
    'anthropic-beta': 'native-feature',
    'x-stainless-lang': 'js',
    'x-client-request-id': 'native-request'
  })
})
