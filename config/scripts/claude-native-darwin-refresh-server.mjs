import { createServer } from 'node:https'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { isDarwinNativeProbeCi } from './claude-native-probe-cli.mjs'

export const EXPIRED_ACCESS = 'sk-ant-oat01-synthetic-expired-darwin'
export const FRESH_ACCESS = 'sk-ant-oat01-synthetic-current-darwin'
export const EXPIRED_REFRESH = 'synthetic-refresh-expired-darwin'
export const ROTATED_REFRESH = 'synthetic-refresh-rotated-darwin'

export async function createDarwinRefreshServer(root) {
  if (!isDarwinNativeProbeCi()) {
    throw new Error('Synthetic refresh server requires isolated Darwin CI')
  }
  const key = join(root, 'tls.key')
  const certificate = join(root, 'tls.crt')
  const configuration = join(root, 'tls.cnf')
  await writeFile(
    configuration,
    '[req]\ndistinguished_name=dn\nx509_extensions=san\nprompt=no\n[dn]\nCN=claude.fedstart.com\n[san]\nsubjectAltName=DNS:claude.fedstart.com\n',
    { mode: 0o600 }
  )
  const result = await runProcess({
    program: '/usr/bin/openssl',
    args: [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      certificate,
      '-days',
      '1',
      '-config',
      configuration
    ],
    timeoutMs: 10000,
    maxOutputBytes: 65536
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('Synthetic TLS certificate creation failed')
  }
  const counts = { refresh: 0, inference: 0, other: 0 }
  const server = createServer(
    { key: await readFile(key), cert: await readFile(certificate) },
    async (request, response) => {
      let body = ''
      for await (const chunk of request) {
        body += chunk
        if (Buffer.byteLength(body) > 65536) {
          response.writeHead(413).end()
          return
        }
      }
      const path = new URL(request.url ?? '/', 'https://localhost').pathname
      if (path === '/v1/messages') {
        counts.inference++
        response.writeHead(503).end()
      } else if (path === '/v1/oauth/token') {
        if (!body.includes(EXPIRED_REFRESH) || !body.includes('refresh_token')) {
          response.writeHead(400).end()
          return
        }
        counts.refresh++
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            access_token: FRESH_ACCESS,
            refresh_token: ROTATED_REFRESH,
            expires_in: 86400,
            token_type: 'Bearer',
            scope: 'user:inference user:profile'
          })
        )
      } else {
        counts.other++
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      }
    }
  )
  server.headersTimeout = 5000
  server.requestTimeout = 10000
  server.maxConnections = 4
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(443, '127.0.0.1', resolve)
  })
  return { certificate, counts, close: () => new Promise((resolve) => server.close(resolve)) }
}
