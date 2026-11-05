import { parse } from 'smol-toml'
import { createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { codexNativeRoutingLaunch } from '../../src/main/codex-routing/codex-native-launch-config.ts'
import { createHash } from 'node:crypto'
import { readFile, writeFile, lstat } from 'node:fs/promises'

export async function writeNativeProbeConfiguration({
  root,
  home,
  workspace,
  frontPort,
  knownModel,
  catalogPath
}) {
  const { getManagedScript } = await import('../../src/main/codex/codex-hook-script.ts')
  const { CODEX_EVENTS, CODEX_EVENT_LABEL } =
    await import('../../src/main/codex/codex-hook-definition.ts')
  const { upsertHookTrustEntriesInContent, upsertProjectTrustLevelInContent } =
    await import('../../src/main/codex/config-toml-trust.ts')
  const canonicalStatus = process.argv.includes('--canonical-status')
  const hookPath = join(root, 'hook.sh'),
    hooksPath = join(home, 'hooks.json')
  if (!canonicalStatus) {
    await writeFile(hookPath, getManagedScript('posix'), { mode: 0o700 })
  }
  const command = `'${hookPath}'`
  const definitions = Object.fromEntries(
    CODEX_EVENTS.map((event) => [
      event,
      [{ hooks: [{ type: 'command', command, timeout: event === 'Interrupt' ? 3 : 10 }] }]
    ])
  )
  if (!canonicalStatus) {
    await writeFile(hooksPath, JSON.stringify({ hooks: definitions }), { mode: 0o600 })
  }
  let config = `model="${knownModel ? 'gpt-6.1-sol' : 'probe-a'}"\nmodel_provider="opka_runtime"\napprovals_reviewer="user"\ncli_auth_credentials_store="file"\ncheck_for_update_on_startup=false\n[model_providers.opka_runtime]\nname="Synthetic native policy"\nbase_url="http://127.0.0.1:${frontPort}/v1"\nwire_api="responses"\nenv_key="OPKA_SYNTHETIC_FRONT_KEY"\nrequires_openai_auth=false\nsupports_websockets=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n`
  if (catalogPath) {
    const bytes = await readFile(catalogPath)
    if (
      bytes.length !== 539696 ||
      createHash('sha256').update(bytes).digest('hex') !==
        '1384625c0b6b3e67d3c60da29becea2b017f2c283fc1e2d05b8edafb4698eb10'
    ) {
      throw new Error('Wrong pinned native source catalog')
    }
    const catalog = join(home, 'synthetic-native-models.json')
    await writeFile(catalog, bytes, { mode: 0o600 })
    config = `model_catalog_json=${JSON.stringify(catalog)}\n${config}`
  }
  config = upsertProjectTrustLevelInContent(config, workspace, 'trusted')
  if (!canonicalStatus) {
    config = upsertHookTrustEntriesInContent(
      config,
      CODEX_EVENTS.map((event) => ({
        sourcePath: hooksPath,
        eventLabel: CODEX_EVENT_LABEL[event],
        groupIndex: 0,
        handlerIndex: 0,
        command,
        timeoutSec: event === 'Interrupt' ? 3 : 10,
        enabled: true
      }))
    )
  }
  await writeFile(join(home, 'config.toml'), config, { mode: 0o600 })
}

export async function readNativeProbeInputs(argv) {
  const argument = (name) => argv[argv.indexOf(name) + 1]
  const values = {
    codex: argument('--codex'),
    enginePath: argument('--engine'),
    output: argument('--output'),
    ptyModule: argument('--pty-module')
  }
  for (const value of Object.values(values)) {
    if (!value || resolve(value) !== value) {
      throw new Error('Explicit absolute pinned binary/output/pty module paths required')
    }
  }
  for (const [path, expected] of [
    [values.codex, 'b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8'],
    [values.enginePath, '7079cd5a49adbe127f957db7528b5a002e6f9076f48b13c99864c6196ae7dba9']
  ]) {
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(path)) {
      hash.update(bytes)
    }
    if (hash.digest('hex') !== expected) {
      throw new Error('Wrong pinned probe binary')
    }
  }
  return values
}

export function nativeProbeRoutingPlan(transport, builtinOpenai = false, gateway = null) {
  if (!builtinOpenai || !gateway) {
    throw new Error('Fresh-namespace diagnostic superseded; use qualified builtin gateway fixture')
  }
  return codexNativeRoutingLaunch({
    baseUrl: gateway.register(transport.apiKey, transport.baseUrl),
    apiKey: gateway.apiKey
  })
}

export async function assertSyntheticOpenAiProviderAbsent(home, workspace) {
  if (process.platform !== 'linux') {
    throw new Error('Synthetic absence fixture qualified on isolated Linux only')
  }
  const config = parse(await readFile(join(home, 'config.toml'), 'utf8'))
  if (config.model_providers?.openai !== undefined) {
    throw new Error('Synthetic HOME has inherited openai table')
  }
  for (const path of [
    join(workspace, '.codex', 'config.toml'),
    '/etc/codex/config.toml',
    '/etc/codex/managed_config.toml',
    join(home, 'managed_config.toml')
  ]) {
    try {
      await lstat(path)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue
      }
      throw error
    }
    throw new Error('Unknown synthetic fixture config layer')
  }
}
