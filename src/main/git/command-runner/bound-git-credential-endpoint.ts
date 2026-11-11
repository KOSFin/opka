import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  isGitCredentialRequest,
  isGitCredentialResponse,
  type GitCredentialRequest,
  type GitCredentialResponse
} from '../../../shared/git-credential-protocol'

const MAX_REQUEST_BYTES = 4096
const ENDPOINT_PATH = '/git-credential'

type CredentialResolver = (
  credential: GitCredentialRequest,
  signal: AbortSignal
) => Promise<GitCredentialResponse | null>

export type BoundGitCredentialEndpoint = {
  env: NodeJS.ProcessEnv
  close: () => Promise<void>
  closed: Promise<void>
}

async function readRequest(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_REQUEST_BYTES) {
      throw new Error('Credential request limit exceeded')
    }
    chunks.push(bytes)
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
}

function isPayload(value: unknown): value is { nonce: string; credential: GitCredentialRequest } {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.keys(value).sort().join(',') === 'credential,nonce' &&
    'nonce' in value &&
    typeof value.nonce === 'string' &&
    'credential' in value &&
    isGitCredentialRequest(value.credential)
  )
}

function refuse(response: ServerResponse): void {
  if (!response.headersSent) {
    response.writeHead(403, { 'Cache-Control': 'no-store', Connection: 'close' })
  }
  response.end()
}

export async function createBoundGitCredentialEndpoint(
  resolveCredential: CredentialResolver,
  options: { deadlineMs: number; signal?: AbortSignal }
): Promise<BoundGitCredentialEndpoint> {
  if (
    !Number.isSafeInteger(options.deadlineMs) ||
    options.deadlineMs < 1 ||
    options.deadlineMs > 30_000
  ) {
    throw new Error('Invalid Git credential deadline')
  }
  const nonce = randomBytes(32).toString('hex')
  const controller = new AbortController()
  let consumed = false
  let closed = false
  let finishClosed: () => void = () => {}
  const closedPromise = new Promise<void>((resolve) => {
    finishClosed = resolve
  })
  const server = createServer((request, response) => {
    void (async () => {
      if (consumed || controller.signal.aborted) {
        refuse(response)
        return
      }
      consumed = true
      server.close()
      if (
        request.method !== 'POST' ||
        request.url !== ENDPOINT_PATH ||
        request.socket.remoteAddress !== '127.0.0.1' ||
        request.headers['content-type'] !== 'application/json'
      ) {
        refuse(response)
        return
      }
      try {
        const payload = await readRequest(request)
        if (!isPayload(payload) || payload.nonce.length !== nonce.length) {
          refuse(response)
          return
        }
        if (!timingSafeEqual(Buffer.from(payload.nonce), Buffer.from(nonce))) {
          refuse(response)
          return
        }
        const credential = await resolveCredential(payload.credential, controller.signal)
        if (controller.signal.aborted || !isGitCredentialResponse(credential)) {
          refuse(response)
          return
        }
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          Connection: 'close'
        })
        response.end(JSON.stringify(credential))
      } catch {
        refuse(response)
      }
    })()
  })
  const close = async (): Promise<void> => {
    if (!closed) {
      closed = true
      controller.abort()
      try {
        server.close()
      } catch {
        finishClosed()
      }
      server.closeAllConnections()
    }
    await closedPromise
  }
  server.on('close', () => {
    closed = true
    controller.abort()
    finishClosed()
  })
  server.on('error', () => {
    void close()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch {
    await close()
    throw new Error('Git credential endpoint unavailable')
  }
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await close()
    throw new Error('Git credential endpoint unavailable')
  }
  const port = address.port
  const timer = setTimeout(() => void close(), options.deadlineMs)
  timer.unref()
  void closedPromise.then(() => clearTimeout(timer))
  const operationSignal = options.signal
  if (operationSignal) {
    if (operationSignal.aborted) {
      await close()
      throw new Error('Git credential operation cancelled')
    }
    const onAbort = (): void => void close()
    operationSignal.addEventListener('abort', onAbort, { once: true })
    void closedPromise.then(() => operationSignal.removeEventListener('abort', onAbort))
  }
  return {
    env: {
      ORCA_INTERNAL_GIT_CREDENTIAL_ENDPOINT: `http://127.0.0.1:${port}${ENDPOINT_PATH}`,
      ORCA_INTERNAL_GIT_CREDENTIAL_NONCE: nonce
    },
    close,
    closed: closedPromise
  }
}
