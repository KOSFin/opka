import { prepareNativeCodexGatewayAuth } from '../../src/main/codex-routing/native-codex-gateway-credential.ts'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Only synthetic credentials in the probe-owned HOME; no provider body or headers retained. */
export async function createNativeProbeAuthTrap(home, report, apiKey = null) {
  const jwt = (payload) =>
    `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.synthetic`
  const file = join(home, 'auth.json')
  const data = JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({
        email: 'synthetic@example.invalid',
        exp: 1,
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'synthetic-native-trap-account',
          chatgpt_user_id: 'synthetic-native-trap-user',
          chatgpt_plan_type: 'plus'
        }
      }),
      access_token: jwt({ exp: 1 }),
      refresh_token: 'synthetic-expired-native-refresh',
      account_id: 'synthetic-native-trap-account'
    },
    last_refresh: '2000-01-01T00:00:00Z'
  })
  const initial = apiKey ? JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey }) : data
  if (apiKey) {
    prepareNativeCodexGatewayAuth(home, apiKey, () => {})
  } else {
    await writeFile(file, initial, { mode: 0o600, flag: 'wx' })
  }
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const before = sha(initial)
  const evidence = {
    realAuth: false,
    expiredSyntheticAuth: !apiKey,
    apiKeyOnly: Boolean(apiKey),
    refreshRequests: 0,
    otherRequests: 0,
    authUnchanged: null
  }
  report.nativeAuth = evidence
  const server = createServer((req, res) => {
    if (req.url === '/refresh') {
      evidence.refreshRequests++
    } else {
      evidence.otherRequests++
    }
    req.resume()
    res
      .writeHead(400, { 'content-type': 'application/json' })
      .end('{"error":"synthetic_refresh_denied"}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    env: {
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${base}/refresh`,
      CODEX_REVOKE_TOKEN_URL_OVERRIDE: `${base}/revoke`
    },
    stop: async () => {
      const final = await readFile(file)
      evidence.authUnchanged = sha(final) === before
      if (apiKey) {
        const auth = JSON.parse(final)
        evidence.noRefreshCredential =
          auth.auth_mode === 'apikey' &&
          Object.keys(auth).sort().join(',') === 'OPENAI_API_KEY,auth_mode'
      }
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    }
  }
}
