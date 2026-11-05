import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import { Readable } from 'node:stream'
import { getMainHttpClient } from '../network/http-client'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'

const ORIGIN = 'https://api.anthropic.com'
const PATHS = new Set(['/v1/messages', '/v1/messages?beta=true'])

export type ClaudeNativeGatewayUpstream = Readable & {
  statusCode: number
  headers: IncomingHttpHeaders
  complete: boolean
  closeBody: () => Promise<void>
}

/** The existing host HTTP client owns egress; callers cannot choose a provider or proxy. */
export async function openClaudeNativeGatewayUpstream(options: {
  path: string
  headers: OutgoingHttpHeaders
  body: Buffer
  signal: AbortSignal
  beforeSend?: () => void
}): Promise<ClaudeNativeGatewayUpstream> {
  if (!PATHS.has(options.path)) {
    throw new Error('Native Claude upstream path is unsupported.')
  }
  options.signal.throwIfAborted()
  const url = ORIGIN + options.path
  await ensureElectronProxyFromEnvironment({ probeUrl: url })
  options.signal.throwIfAborted()
  const headers = new Headers()
  for (const [name, value] of Object.entries(options.headers)) {
    if (value !== undefined) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        headers.append(name, String(entry))
      }
    }
  }
  headers.set('accept-encoding', 'identity')
  const client = getMainHttpClient()
  options.beforeSend?.()
  const response = await client.fetch(url, {
    method: 'POST',
    headers,
    body: new Uint8Array(options.body),
    signal: options.signal,
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer'
  })
  const encoding = response.headers.get('content-encoding')
  if (encoding && encoding.trim().toLowerCase() !== 'identity') {
    // Fetch decodes bodies; forwarding the retained encoding would corrupt native responses.
    await response.body?.cancel()
    throw new Error('Native Claude upstream response encoding is unsupported.')
  }
  return streamResponse(response)
}

function streamResponse(response: Response): ClaudeNativeGatewayUpstream {
  const reader = response.body?.getReader()
  let completed = reader === undefined
  let cancellation: Promise<void> | undefined
  let released = false
  const release = () => {
    if (!released && reader) {
      reader.releaseLock()
      released = true
    }
  }
  const cancel = () => {
    cancellation ??= (async () => {
      try {
        await reader?.cancel()
      } finally {
        release()
      }
    })()
    return cancellation
  }
  async function* chunks() {
    try {
      while (reader) {
        const next = await reader.read()
        if (next.done) {
          completed = true
          break
        }
        yield Buffer.from(next.value)
      }
    } finally {
      if (!completed) {
        await cancel()
      } else {
        release()
      }
    }
  }
  const stream = Readable.from(chunks(), { objectMode: false, highWaterMark: 64 * 1024 })
  const upstream = Object.assign(stream, {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    complete: false,
    async closeBody() {
      stream.destroy()
      if (!completed) {
        await cancel()
      }
    }
  })
  stream.once('end', () => {
    upstream.complete = true
  })
  stream.once('close', () => {
    if (!completed) {
      // closeBody joins this cancellation before the host releases ownership.
      void cancel().catch(() => {})
    }
  })
  return upstream
}
