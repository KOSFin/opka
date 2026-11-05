import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'

const option = (name) => process.argv[process.argv.indexOf(name) + 1]
const binary = option('--codex'),
  output = option('--output'),
  catalogPath = option('--catalog')
if (![binary, output, catalogPath].every((path) => path && resolve(path) === path)) {
  throw new Error('Explicit absolute pinned binary/output required')
}
async function sha(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}
if ((await sha(binary)) !== 'b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8') {
  throw new Error('Wrong pinned native binary')
}
const root = await mkdtemp(join(dirname(output), 'native-config-read-scratch-'))
const home = join(root, 'home'),
  codexHome = join(home, '.codex'),
  workspace = join(home, 'workspace')
await mkdir(codexHome, { recursive: true, mode: 0o700 })
await mkdir(join(workspace, '.codex'), { recursive: true, mode: 0o700 })
const calls = []
const trap = createServer((req, res) => {
  if (calls.length < 16) {
    calls.push({ method: req.method, path: req.url })
  }
  req.resume()
  res
    .writeHead(400, { 'content-type': 'application/json' })
    .end('{"error":"synthetic_refresh_denied"}')
})
trap.listen(0, '127.0.0.1')
await once(trap, 'listening')
const url = `http://127.0.0.1:${trap.address().port}`
const jwt = (payload) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.synthetic`
const id = jwt({
  email: 'synthetic@example.invalid',
  exp: 1,
  'https://api.openai.com/auth': {
    chatgpt_account_id: 'synthetic-config-read-account',
    chatgpt_user_id: 'synthetic-config-read-user',
    chatgpt_plan_type: 'plus'
  }
})
const explicitCatalog = join(codexHome, 'explicit-catalog.json')
const catalog = await readFile(catalogPath)
if (
  catalog.length !== 539696 ||
  createHash('sha256').update(catalog).digest('hex') !==
    '1384625c0b6b3e67d3c60da29becea2b017f2c283fc1e2d05b8edafb4698eb10'
) {
  throw new Error('Wrong pinned native catalog')
}
await writeFile(explicitCatalog, catalog, { mode: 0o600 })
const authPath = join(codexHome, 'auth.json')
await writeFile(
  authPath,
  JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: id,
      access_token: jwt({ exp: 1 }),
      refresh_token: 'synthetic-expired-refresh-token',
      account_id: 'synthetic-config-read-account'
    },
    last_refresh: '2000-01-01T00:00:00Z'
  }),
  { mode: 0o600 }
)
const authHash = await sha(authPath)
await writeFile(
  join(codexHome, 'config.toml'),
  `model="synthetic-home-model"\nmodel_reasoning_effort="high"\ncheck_for_update_on_startup=false\ncli_auth_credentials_store="file"\nmodel_catalog_json=${JSON.stringify(explicitCatalog)}\n[model_providers.synthetic_config_read]\nname="Synthetic config-only"\nbase_url="${url}/v1"\nwire_api="responses"\nenv_key="SYNTHETIC_CONFIG_KEY"\nrequires_openai_auth=false\n[mcp_servers.synthetic]\ncommand="/synthetic/never-execute"\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n`,
  { mode: 0o600 }
)
await writeFile(join(workspace, '.codex', 'config.toml'), 'model="synthetic-project-model"\n', {
  mode: 0o600
})
const { parse } = await import('smol-toml')
const fixture = parse(await readFile(join(codexHome, 'config.toml'), 'utf8'))
if (!fixture.model_providers?.synthetic_config_read) {
  throw new Error('Synthetic TOML fixture invalid')
}
const allow = new Set(['PATH', 'LANG'])
for (const key of Object.keys(process.env)) {
  if (!allow.has(key)) {
    delete process.env[key]
  }
}
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  CODEX_HOME: codexHome,
  XDG_CACHE_HOME: join(home, '.cache'),
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_STATE_HOME: join(home, '.state'),
  TMPDIR: join(home, 'tmp'),
  ORCA_BACKGROUND_LAUNCH: '1',
  SYNTHETIC_CONFIG_KEY: 'synthetic-config-only-key',
  CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${url}/refresh`,
  CODEX_REVOKE_TOKEN_URL_OVERRIDE: `${url}/revoke`
})
await mkdir(process.env.TMPDIR, { mode: 0o700 })
process.chdir(workspace)
const { runCodexAppServerSession } =
  await import('../../src/main/codex/codex-app-server-session.ts')
async function snapshot() {
  const files = [],
    dirs = []
  let totalBytes = 0
  async function visit(path) {
    const entries = await readdir(path)
    for (const name of entries.sort()) {
      if (files.length + dirs.length >= 256) {
        throw new Error('Fake HOME inventory exceeds probe bound')
      }
      const child = join(path, name),
        stat = await lstat(child)
      if (stat.isSymbolicLink()) {
        throw new Error('Unexpected fake HOME symlink')
      }
      if (stat.isDirectory()) {
        dirs.push(relative(home, child))
        await visit(child)
      } else if (stat.isFile()) {
        totalBytes += stat.size
        if (totalBytes > 64 * 1024 * 1024) {
          throw new Error('Fake HOME exceeds 64MiB probe bound')
        }
        files.push({ path: relative(home, child), bytes: stat.size, sha256: await sha(child) })
      } else {
        throw new Error('Unexpected fake HOME file kind')
      }
    }
  }
  await visit(home)
  return { totalBytes, files, directories: dirs }
}
const report = {
  version: 1,
  scenario: 'native-config-read-auth-neutral-storage',
  nativeVersion: '0.166.0',
  realAuth: false,
  inference: false,
  sharedSupervisedRunner: true,
  profileSupportProven: false,
  configurationScope: 'default-home-and-cwd-only',
  repetitions: [],
  trapCalls: calls
}
let phase = 'snapshot'
try {
  report.before = await snapshot()
  for (let index = 0; index < 5; index++) {
    phase = 'initialize'
    const result = await runCodexAppServerSession(
      {
        command: binary,
        cliPath: binary,
        env: { ...process.env },
        timeoutMs: 5000,
        args: [
          '--no-daemon',
          '-C',
          workspace,
          '-c',
          'model_provider="synthetic_config_read"',
          '-c',
          `model_providers.synthetic_config_read={name="Synthetic config-only",base_url="${url}/v1",wire_api="responses",env_key="SYNTHETIC_CONFIG_KEY",requires_openai_auth=false}`,
          '-c',
          'features.plugins=false',
          '-c',
          'features.api_key_model_discovery=false',
          '-c',
          'model="synthetic-cli-model"',
          '-s',
          'read-only',
          '-a',
          'never',
          'app-server'
        ]
      },
      async (rpc) => {
        phase = 'config/read'
        const value = await rpc.request(
          'config/read',
          { includeLayers: true, cwd: workspace },
          { timeoutMs: 2000 }
        )
        phase = 'account/read'
        const account =
          index === 0
            ? await rpc.request('account/read', { refreshToken: false }, { timeoutMs: 2000 })
            : undefined
        return { config: value?.config, account }
      }
    )
    const config = result.config
    report.repetitions.push({
      index,
      effectiveModel: config?.model,
      explicitCatalogPreserved: config?.model_catalog_json === explicitCatalog,
      effortPreserved: config?.model_reasoning_effort === 'high',
      returnedConfigKeys: Object.keys(config ?? {}).sort(),
      mcpPreserved: config?.mcp_servers?.synthetic?.command === '/synthetic/never-execute',
      ...(index === 0 ? { cachedAccountType: result.account?.account?.type ?? null } : {}),
      authUnchanged: (await sha(authPath)) === authHash,
      inventory: await snapshot()
    })
  }
  report.noRefreshOrModelRequests = calls.length === 0
  report.configPreserved = report.repetitions.every(
    (item) =>
      item.effectiveModel === 'synthetic-cli-model' &&
      item.explicitCatalogPreserved &&
      item.effortPreserved &&
      item.mcpPreserved
  )
  report.authUnchanged = report.repetitions.every((item) => item.authUnchanged)
  report.equalRepeatedPathsAndBytes = report.repetitions.every(
    (item) =>
      JSON.stringify(item.inventory.files.map(({ path, bytes }) => ({ path, bytes }))) ===
      JSON.stringify(
        report.repetitions[0].inventory.files.map(({ path, bytes }) => ({ path, bytes }))
      )
  )
  report.passed =
    report.noRefreshOrModelRequests &&
    report.configPreserved &&
    report.authUnchanged &&
    report.equalRepeatedPathsAndBytes &&
    report.repetitions[0].cachedAccountType === 'chatgpt'
} catch (error) {
  report.phase = phase
  const text = error instanceof Error ? error.message : ''
  report.failureSignals = Object.fromEntries(
    [
      'ENOENT',
      'EACCES',
      'profile',
      'config',
      'model',
      'timeout',
      'unsupported',
      'not found',
      'argument',
      'supervisor'
    ].map((word) => [word, text.toLowerCase().includes(word.toLowerCase())])
  )
  report.authUnchanged = (await sha(authPath)) === authHash
  report.afterFailure = await snapshot()
  report.passed = false
  report.failure = 'Config-only supervised read failed; no raw provider/config/auth error retained'
} finally {
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 })
  trap.closeAllConnections()
  await new Promise((done) => trap.close(done))
  await rm(root, { recursive: true, force: true })
}
console.log(
  JSON.stringify({
    passed: report.passed,
    noRefreshOrModelRequests: report.noRefreshOrModelRequests,
    equalRepeatedPathsAndBytes: report.equalRepeatedPathsAndBytes,
    configPreserved: report.configPreserved
  })
)
if (!report.passed) {
  process.exitCode = 1
}
