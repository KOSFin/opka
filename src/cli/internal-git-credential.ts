import type { Readable } from 'node:stream'
import {
  isGitCredentialResponse,
  type GitCredentialRequest
} from '../shared/git-credential-protocol'

const MAX_PROTOCOL_BYTES = 4096
const ENDPOINT_PATH = '/git-credential'
const REQUEST_TIMEOUT_MS = 3000
const REFUSAL = 'Git credential unavailable.\n'

async function readProtocol(input: Readable, retain: boolean): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_PROTOCOL_BYTES) {
      throw new Error('Credential input limit exceeded')
    }
    if (retain) {
      chunks.push(bytes)
    }
  }
  return retain ? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) : ''
}

export function parseGitCredentialRequest(input: string): GitCredentialRequest {
  if (!input.endsWith('\n\n') || input.includes('\r') || input.includes('\0')) {
    throw new Error('Invalid credential protocol')
  }
  const fields = new Map<string, string>()
  for (const line of input.slice(0, -2).split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0 || line.slice(separator + 1).includes('\n')) {
      throw new Error('Invalid credential field')
    }
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (!['protocol', 'host', 'path', 'username'].includes(key) || fields.has(key)) {
      throw new Error('Unexpected credential field')
    }
    fields.set(key, value)
  }
  const protocol = fields.get('protocol')
  const host = fields.get('host')
  if (protocol !== 'https' || !host || /[\s/@]/.test(host)) {
    throw new Error('Unsupported credential target')
  }
  const path = fields.get('path')
  const username = fields.get('username')
  if (path?.includes('\\')) {
    throw new Error('Unsupported credential target')
  }
  return {
    protocol,
    host,
    ...(path === undefined ? {} : { path }),
    ...(username === undefined ? {} : { username })
  }
}

function parseEndpoint(env: NodeJS.ProcessEnv): { url: URL; nonce: string } {
  const raw = env.ORCA_INTERNAL_GIT_CREDENTIAL_ENDPOINT
  const nonce = env.ORCA_INTERNAL_GIT_CREDENTIAL_NONCE
  if (!raw || !nonce || !/^[a-f0-9]{64}$/.test(nonce)) {
    throw new Error('Missing credential endpoint')
  }
  const url = new URL(raw)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== ENDPOINT_PATH ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error('Invalid credential endpoint')
  }
  return { url, nonce }
}

async function readBoundedResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    throw new Error('Credential endpoint refused')
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > MAX_PROTOCOL_BYTES) {
      throw new Error('Credential response limit exceeded')
    }
    chunks.push(chunk)
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
}

export async function resolveInternalGitCredential(
  operation: string | undefined,
  input: Readable,
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch
): Promise<string | null> {
  if (operation === 'store' || operation === 'erase') {
    await readProtocol(input, false)
    return null
  }
  if (operation !== 'get') {
    throw new Error('Unsupported credential operation')
  }
  const { url, nonce } = parseEndpoint(env)
  const credential = parseGitCredentialRequest(await readProtocol(input, true))
  const response = await fetcher(url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, credential }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  const result = await readBoundedResponse(response)
  if (!isGitCredentialResponse(result)) {
    throw new Error('Invalid credential response')
  }
  return `username=${result.username}\npassword=${result.password}\n\n`
}

export async function runInternalGitCredentialCli(argv: string[]): Promise<void> {
  try {
    if (argv.length !== 1) {
      throw new Error('Invalid credential operation')
    }
    const result = await resolveInternalGitCredential(argv[0], process.stdin, process.env)
    if (result !== null) {
      process.stdout.write(result)
    }
  } catch {
    process.stderr.write(REFUSAL)
    process.exitCode = 1
  }
}
