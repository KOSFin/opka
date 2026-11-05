import { parse } from 'smol-toml'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { spawnProcess } from '@orca/process-host'
import { codexNativeRoutingLaunch } from '../../src/main/codex-routing/codex-native-launch-config.ts'
import { nativeCliLaunchArguments } from '../../src/shared/native-cli-launch-arguments.ts'

const option = (name) => process.argv[process.argv.indexOf(name) + 1]
const binary = option('--codex'),
  output = option('--output'),
  catalogPath = option('--catalog')
for (const path of [binary, output, catalogPath]) {
  if (!path || resolve(path) !== path) {
    throw new Error('Explicit absolute pinned binary/catalog/output required')
  }
}
const hash = createHash('sha256')
for await (const chunk of createReadStream(binary)) {
  hash.update(chunk)
}
if (hash.digest('hex') !== 'b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8') {
  throw new Error('Wrong pinned native binary')
}
const catalog = await readFile(catalogPath)
if (
  catalog.length !== 539696 ||
  createHash('sha256').update(catalog).digest('hex') !==
    '1384625c0b6b3e67d3c60da29becea2b017f2c283fc1e2d05b8edafb4698eb10'
) {
  throw new Error('Wrong pinned source catalog')
}
const root = await mkdtemp(join(dirname(output), 'native-config-scratch-'))
const cases = []
const capability = 'synthetic-native-config-capability-00000001'
let child
const trapRequests = []
const trap = createServer((req, res) => {
  if (trapRequests.length < 8) {
    trapRequests.push({
      authorizationMatches: req.headers.authorization === `Bearer ${capability}`
    })
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(catalog)
})
const unexpected = []
const front = createServer((req, res) => {
  unexpected.push(req.method)
  res.writeHead(400).end()
})
front.listen(0, '127.0.0.1')
await once(front, 'listening')
const baseUrl = `http://127.0.0.1:${front.address().port}/v1`
trap.listen(0, '127.0.0.1')
await once(trap, 'listening')
try {
  for (const fresh of [false, true]) {
    const home = join(root, fresh ? 'fresh' : 'baseline'),
      workspace = join(home, 'workspace')
    await mkdir(workspace, { recursive: true, mode: 0o700 })
    const catalogUrl = `http://127.0.0.1:${trap.address().port}/models`
    await writeFile(
      join(home, 'config.toml'),
      `model="gpt-6.1-sol"\ncheck_for_update_on_startup=false\n[model_providers.opka_runtime]\nname="Synthetic inherited provider"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nmodel_catalog_url=${JSON.stringify(catalogUrl)}\nhttp_headers={X-Synthetic-Stale="yes"}\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n`,
      { mode: 0o600 }
    )
    const plan = codexNativeRoutingLaunch({
      baseUrl,
      apiKey: capability
    })
    const provider = parse(plan.codexConfigOverrides.join('\n')).model_provider
    const testPlan = fresh
      ? plan
      : {
          ...plan,
          codexConfigOverrides: plan.codexConfigOverrides.map((value) =>
            value.replaceAll(provider, 'opka_runtime')
          )
        }
    const env = Object.fromEntries(
      ['PATH', 'LANG']
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]])
    )
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: home,
      ORCA_BACKGROUND_LAUNCH: '1',
      ...testPlan.env
    })
    child = spawnProcess({
      program: binary,
      args: nativeCliLaunchArguments(
        'codex',
        ['--no-daemon', '-C', workspace, 'app-server'],
        testPlan
      ),
      env,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    let carry = '',
      bytes = 0
    const result = await new Promise((done, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('Native config read deadline'))
      }, 7000)
      const fail = (error) => {
        clearTimeout(timer)
        reject(error)
      }
      child.once('error', fail)
      child.once('exit', () => fail(new Error('Native exited before config response')))
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 1024 * 1024) {
          child.kill('SIGKILL')
          fail(new Error('Native config output exceeded probe bound'))
          return
        }
        carry += chunk.toString()
        const lines = carry.split('\n')
        carry = lines.pop() ?? ''
        for (const line of lines) {
          let message
          try {
            message = JSON.parse(line)
          } catch {
            continue
          }
          if (message.id === 1) {
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`
            )
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'config/read', params: { includeLayers: false } })}\n`
            )
          }
          if (message.id === 2) {
            clearTimeout(timer)
            done(message)
            return
          }
        }
      })
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'synthetic_config_probe', version: '1' }, capabilities: { experimentalApi: true } } })}\n`
      )
    })
    const config = result.result?.config
    if (!config) {
      throw new Error(
        `Native config response missing: ${JSON.stringify({ error: result.error, resultKeys: Object.keys(result.result ?? {}) })}`
      )
    }
    const selected = config.model_provider ?? config.modelProvider
    const providers = config.model_providers ?? config.modelProviders
    const current = providers?.[selected]
    if (!current) {
      throw new Error('Native selected provider absent from config response')
    }
    cases.push({
      freshNamespace: fresh,
      currentProvider: selected,
      forcedBaseUrl: current.base_url === baseUrl,
      inheritedCatalog: current.model_catalog_url === catalogUrl,
      inheritedHeader: current.http_headers?.['X-Synthetic-Stale'] === 'yes'
    })
    const exited = once(child, 'close')
    child.stdin.end()
    await exited
    child = null
  }
} finally {
  if (child?.exitCode === null) {
    child.kill('SIGKILL')
  }
  front.closeAllConnections()
  await new Promise((done) => front.close(done))
  trap.closeAllConnections()
  await new Promise((done) => trap.close(done))
  await rm(root, { recursive: true, force: true })
  await writeFile(
    output,
    `${JSON.stringify({ cases, trapRequests, scope: 'actual native app-server config layering only; production fresh namespace and legacy fixed baseline; no inference/auth/model calls' }, null, 2)}\n`,
    { mode: 0o600 }
  )
}
if (
  cases.length !== 2 ||
  !cases[0].inheritedCatalog ||
  !cases[0].inheritedHeader ||
  cases[1].inheritedCatalog ||
  cases[1].inheritedHeader
) {
  throw new Error('Native config-layer result did not match expected fixed/fresh comparison')
}
console.log(
  JSON.stringify({
    ok: true,
    cases: cases.map(({ freshNamespace, inheritedCatalog, inheritedHeader }) => ({
      freshNamespace,
      inheritedCatalog,
      inheritedHeader
    }))
  })
)
