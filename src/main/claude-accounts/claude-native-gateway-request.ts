import { visit } from 'jsonc-parser'
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const NATIVE_SESSION = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,199}$/
const MAX_METADATA_CHARS = 16 * 1024
function reject(): never {
  throw new Error('Native Claude request identity is unsupported.')
}

/** Visit the bounded wire document without materializing messages, tools or attachment trees. */
export function readClaudeNativeGatewayRequest(bytes: Buffer, nativeAccountUuid: string) {
  let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  let depth = 0,
    nodes = 0,
    model = '',
    messages = 0,
    metadataOffset = -1,
    metadataLength = 0,
    sessionId = '',
    portable = true
  let metadata: { raw: string; accountOffset: number; accountLength: number } | undefined
  let parentSessionId: string | undefined
  const rootKeys = new Set<string>(),
    metadataKeys = new Set<string>()
  const begin = () => {
    if (++depth > 64 || ++nodes > 100_000) {
      reject()
    }
  }
  visit(
    text,
    {
      onObjectBegin(_offset, _length, _line, _character, path) {
        begin()
        const value = path()
        if (value.length === 1 && value[0] === 'container') {
          reject()
        }
        if (value.length === 2 && value[0] === 'messages' && typeof value[1] === 'number') {
          messages++
        }
      },
      onArrayBegin(_offset, _length, _line, _character, path) {
        begin()
        const value = path()
        if (value.length === 1 && value[0] === 'container') {
          reject()
        }
      },
      onObjectEnd: () => {
        depth--
      },
      onArrayEnd: () => {
        depth--
      },
      onObjectProperty(key, _offset, _length, _line, _character, path) {
        if (['file_id', 'container_id', 'encrypted_content'].includes(key)) {
          portable = false
        }
        if (++nodes > 100_000 || key.length > 1024) {
          reject()
        }
        const value = path()
        const keys =
          value.length === 0
            ? rootKeys
            : value.length === 1 && value[0] === 'metadata'
              ? metadataKeys
              : null
        if (keys) {
          if (keys.has(key) || keys.size >= 1024) {
            reject()
          }
          keys.add(key)
        }
      },
      onLiteralValue(value: unknown, offset, length, _line, _character, path) {
        if (++nodes > 100_000) {
          reject()
        }
        const location = path()
        if (location.length === 1 && location[0] === 'container' && value !== null) {
          reject()
        }
        if (location.length === 1 && location[0] === 'model') {
          if (typeof value !== 'string' || !value || value.length > 200) {
            reject()
          }
          model = value
        }
        if (location.length !== 2 || location[0] !== 'metadata' || location[1] !== 'user_id') {
          return
        }
        if (typeof value !== 'string' || value.length > MAX_METADATA_CHARS) {
          reject()
        }
        let decoded: unknown
        const identityKeys = new Set<string>()
        let identityDepth = 0,
          accountOffset = -1,
          accountLength = 0
        visit(
          value,
          {
            onObjectBegin() {
              if (++identityDepth > 8) {
                reject()
              }
            },
            onObjectEnd() {
              identityDepth--
            },
            onArrayBegin() {
              if (++identityDepth > 8) {
                reject()
              }
            },
            onArrayEnd() {
              identityDepth--
            },
            onObjectProperty(key, _o, _l, _line, _character, path) {
              if (path().length === 0) {
                if (identityKeys.has(key) || identityKeys.size >= 64) {
                  reject()
                }
                identityKeys.add(key)
              }
            },
            onLiteralValue(_entry: unknown, offset, length, _line, _character, path) {
              const keys = path()
              if (keys.length === 1 && keys[0] === 'account_uuid') {
                accountOffset = offset
                accountLength = length
              }
            },
            onError: reject
          },
          { disallowComments: true, allowTrailingComma: false }
        )
        try {
          decoded = JSON.parse(value)
        } catch {
          reject()
        }
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
          reject()
        }
        const fields = Object.entries(decoded)
        if (
          fields.length > 64 ||
          !('account_uuid' in decoded) ||
          decoded.account_uuid !== nativeAccountUuid ||
          !('session_id' in decoded) ||
          typeof decoded.session_id !== 'string' ||
          !NATIVE_SESSION.test(decoded.session_id) ||
          'tk' in decoded ||
          accountOffset < 0
        ) {
          reject()
        }
        if ('parent_session_id' in decoded) {
          if (
            typeof decoded.parent_session_id !== 'string' ||
            !NATIVE_SESSION.test(decoded.parent_session_id)
          ) {
            reject()
          }
          parentSessionId = decoded.parent_session_id
        }
        metadata = { raw: value, accountOffset, accountLength }
        sessionId = decoded.session_id
        metadataOffset = Buffer.byteLength(text.slice(0, offset))
        metadataLength = Buffer.byteLength(text.slice(offset, offset + length))
      },
      onError: reject
    },
    { disallowComments: true, allowTrailingComma: false }
  )
  if (!model || !messages || !metadata || metadataOffset < 0 || !UUID.test(nativeAccountUuid)) {
    reject()
  }
  const held = metadata
  text = ''
  return {
    model,
    sessionId,
    parentSessionId,
    messageCount: messages,
    portable,
    forAccount(accountUuid: string): Buffer {
      if (!UUID.test(accountUuid) || (!portable && accountUuid !== nativeAccountUuid)) {
        reject()
      }
      const rewritten =
        held.raw.slice(0, held.accountOffset) +
        JSON.stringify(accountUuid) +
        held.raw.slice(held.accountOffset + held.accountLength)
      const replacement = Buffer.from(JSON.stringify(rewritten))
      return Buffer.concat([
        bytes.subarray(0, metadataOffset),
        replacement,
        bytes.subarray(metadataOffset + metadataLength)
      ])
    }
  }
}

/** Forward native protocol features, never caller auth, cookies or unqualified identity headers. */
export function claudeNativeGatewayHeaders(
  source: IncomingHttpHeaders,
  accessToken: string
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  const connection = new Set(source.connection?.split(',').map((name) => name.trim().toLowerCase()))
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      !connection.has(name) &&
      ([
        'accept',
        'accept-encoding',
        'content-type',
        'anthropic-version',
        'anthropic-beta',
        'user-agent',
        'x-app',
        'x-client-request-id',
        'traceparent'
      ].includes(name) ||
        /^x-stainless-[a-z-]+$/.test(name))
    ) {
      headers[name] = value
    }
  }
  return { ...headers, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }
}
