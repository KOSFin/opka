import { build } from 'esbuild'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { writeFile, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function prepareNativeUsageOpenInputFixture(root, config, project, runProcess) {
  const tlsKey = join(root, 'tls.key'),
    certificate = join(root, 'tls.crt')
  const certificateResult = await runProcess({
    program: '/usr/bin/openssl',
    args: [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      tlsKey,
      '-out',
      certificate,
      '-days',
      '1',
      '-subj',
      '/CN=claude.fedstart.com',
      '-addext',
      'subjectAltName=DNS:claude.fedstart.com'
    ],
    timeoutMs: 10000,
    maxOutputBytes: 4096
  })
  if (
    certificateResult.code !== 0 ||
    certificateResult.timedOut ||
    certificateResult.outputTruncated
  ) {
    throw new Error('Synthetic certificate setup failed')
  }
  const oldAccess = 'sk-ant-oat01-synthetic-old-open-input',
    freshAccess = 'sk-ant-oat01-synthetic-fresh-open-input'
  const oldRefresh = 'synthetic-old-refresh-open-input',
    freshRefresh = 'synthetic-fresh-refresh-open-input'
  const credentialPath = join(config, '.credentials.json')
  await writeFile(
    credentialPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: oldAccess,
        refreshToken: oldRefresh,
        expiresAt: Date.now() - 60000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max'
      }
    }),
    { mode: 0o600 }
  )
  const state = JSON.stringify({
    hasCompletedOnboarding: true,
    oauthAccount: {
      accountUuid: randomUUID(),
      organizationUuid: randomUUID(),
      emailAddress: 'synthetic@example.invalid'
    },
    projects: { [project]: { hasTrustDialogAccepted: true } }
  })
  for (const name of ['.claude.json', '.claude-custom-oauth.json']) {
    await writeFile(join(config, name), state, { mode: 0o600 })
  }
  await writeFile(join(config, 'settings.json'), '{"disableAllHooks":true}', { mode: 0o600 })
  return { tlsKey, certificate, credentialPath, oldRefresh, freshAccess, freshRefresh }
}

export async function readNativeUsageCredentialState(path, access, refresh) {
  const value = JSON.parse(await readFile(path, 'utf8')).claudeAiOauth ?? {}
  return {
    fresh: value.accessToken === access && value.expiresAt > Date.now(),
    rotated: value.refreshToken === refresh
  }
}
export async function waitNativeUsageFreshSource(path, access, refresh, isClosed) {
  let value = await readNativeUsageCredentialState(path, access, refresh)
  for (let index = 0; index < 40 && !value.fresh && !isClosed(); index++) {
    await delay(100)
    value = await readNativeUsageCredentialState(path, access, refresh)
  }
  return value
}

export async function buildNativeUsageProbeRuntime(root) {
  const bundle = join(root, 'production.mjs')
  await build({
    stdin: {
      contents:
        "export {runAgentModelCatalogListing} from './src/main/native-chat/agent-model-catalog/agent-model-catalog-probe-runner.ts';" +
        "export {readPosixProcessRow} from './src/main/provider-process/provider-process-row-read.ts';" +
        "export {runProcess} from '@orca/process-host';",
      resolveDir: process.cwd()
    },
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    conditions: ['orca-source'],
    external: ['electron'],
    logLevel: 'silent',
    banner: {
      js: "import {createRequire as opkaUsageCreateRequire} from 'node:module';import {fileURLToPath as opkaUsageFileURLToPath} from 'node:url';import {dirname as opkaUsageDirname} from 'node:path';const require=opkaUsageCreateRequire(import.meta.url);const __filename=opkaUsageFileURLToPath(import.meta.url);const __dirname=opkaUsageDirname(__filename);"
    }
  })
  return import(pathToFileURL(bundle).href)
}
