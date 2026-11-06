import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { renameFileWithWindowsRetry } from '../codex-accounts/fs-utils'
import {
  getProxyUrlFromEnvironment,
  normalizeProxyUrl,
  type NetworkProxySettings
} from '../../shared/network-proxy'

export type EngineReadyAuthReference =
  | {
      kind: 'ready-engine-auth'
      directory: string
      /** Stable engine credential ID and unique prefix from the host's verified account connection. */
      credentialId: string
      prefix: string
    }
  | { kind: 'synthetic-test'; upstream: string; accounts?: readonly ['A', 'B'] }
  | { kind: 'device-enrollment'; directory: string }

export type EngineRuntimeFiles = {
  host: '127.0.0.1'
  port: number
  clientKey: string
  configPath: string
  directory: string
}

export type EngineRuntimeConfigOptions = {
  directory: string
  port: number
  auth: EngineReadyAuthReference
  maxRequestBytes: number
  networkProxySettings?: NetworkProxySettings | null
  /** The host must own the directory lease and have excluded a live previous engine/writer. */
  assertExclusiveRuntimeDirectory: () => void
}

export function ensurePrivateEngineDirectory(directory: string): void {
  if (!isAbsolute(directory)) {
    throw new Error('Engine runtime directories must be absolute')
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const metadata = lstatSync(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Engine runtime directory must be an owned regular directory')
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new Error('Engine runtime directory belongs to another user')
    }
    chmodSync(directory, 0o700)
  }
}

function syntheticUpstream(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Synthetic engine upstream must be an explicit loopback HTTP endpoint')
  }
  return url.toString().replace(/\/$/, '')
}

/** No provider credentials are read, copied, imported or generated here. */
export function prepareEngineRuntimeConfig(
  options: EngineRuntimeConfigOptions
): EngineRuntimeFiles {
  const { directory, port, auth, maxRequestBytes } = options
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isSafeInteger(maxRequestBytes) ||
    maxRequestBytes < 1 ||
    maxRequestBytes > 32 * 1024 * 1024
  ) {
    throw new Error('Engine listener port or request byte budget is invalid')
  }
  options.assertExclusiveRuntimeDirectory()
  ensurePrivateEngineDirectory(directory)
  const authDirectory =
    auth.kind !== 'synthetic-test' ? auth.directory : join(directory, 'empty-auth')
  if (auth.kind === 'ready-engine-auth') {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(auth.prefix) ||
      !auth.credentialId ||
      auth.credentialId.length > 512 ||
      /[\r\n\0]/.test(auth.credentialId)
    ) {
      throw new Error('A stable engine credential ID and unique model prefix are required')
    }
    if (
      !isAbsolute(authDirectory) ||
      !lstatSync(authDirectory).isDirectory() ||
      lstatSync(authDirectory).isSymbolicLink()
    ) {
      throw new Error('An already validated engine-owned auth directory is required')
    }
  } else {
    ensurePrivateEngineDirectory(authDirectory)
  }
  if (
    auth.kind === 'synthetic-test' &&
    auth.accounts !== undefined &&
    (auth.accounts.length !== 2 || auth.accounts[0] !== 'A' || auth.accounts[1] !== 'B')
  ) {
    throw new Error('Synthetic routing only accepts the fixed A/B fixture')
  }
  const proxy =
    auth.kind === 'synthetic-test'
      ? normalizeProxyUrl('')
      : options.networkProxySettings === undefined
        ? getProxyUrlFromEnvironment(process.env)
        : normalizeProxyUrl(options.networkProxySettings?.httpProxyUrl)
  if (!proxy.ok) {
    throw new Error('Routing engine proxy configuration is invalid.')
  }
  const clientKey = randomBytes(32).toString('hex')
  const config = {
    'config-version': 8,
    ...(proxy.value ? { requests: { 'proxy-url': proxy.value } } : {}),
    server: {
      host: '127.0.0.1',
      port,
      'commercial-mode': true,
      'max-request-body-bytes': maxRequestBytes,
      'kv-store': { disabled: true },
      discovery: { enabled: false }
    },
    management: {
      'secret-key': '',
      'allow-remote': false,
      'disable-control-panel': true,
      'disable-auto-update-panel': true
    },
    access: { 'api-keys': [clientKey] },
    oauth: { 'auth-dir': authDirectory, 'auth-auto-refresh-workers': 1 },
    routing: {
      strategy: 'fill-first',
      'force-model-prefix':
        auth.kind === 'ready-engine-auth' ||
        (auth.kind === 'synthetic-test' && auth.accounts !== undefined),
      'session-affinity': false,
      retry: { 'request-retry': 0, 'max-retry-interval': 0 },
      cooldown: { 'disable-cooling': true, 'save-cooldown-status': false }
    },
    ...(auth.kind === 'synthetic-test'
      ? {
          'api-keys': {
            codex: (auth.accounts ?? [undefined]).map((account) => ({
              name: account ? `synthetic-${account}` : 'synthetic',
              ...(account ? { prefix: `synthetic-${account}` } : {}),
              'base-url': syntheticUpstream(auth.upstream),
              'request-retry': 0,
              models: (account
                ? ['probe', 'probe-a', 'probe-b', 'gpt-6.1-sol', 'gpt-6.1-terra']
                : ['probe']
              ).map((name) => ({
                name
              })),
              keys: [
                {
                  'api-key': account ? `synthetic-${account}` : 'synthetic-no-provider-credential',
                  'disable-codex-cloaking': true
                }
              ]
            }))
          }
        }
      : {}),
    observability: {
      logs: { debug: false, 'logging-to-file': false, 'request-log': false },
      usage: { 'usage-statistics-enabled': false },
      pprof: { enable: false }
    },
    plugins: { enabled: false }
  }
  const configPath = join(directory, 'config.json')
  const stagedPath = `${configPath}.next`
  for (const path of [configPath, stagedPath]) {
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
      throw new Error('Engine configuration paths must be regular owned files')
    }
  }
  options.assertExclusiveRuntimeDirectory()
  // The fixed reserved stage is recoverable only under the host's exclusive runtime lease.
  rmSync(stagedPath, { force: true })
  const fd = openSync(stagedPath, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(config)}\n`)
  } finally {
    closeSync(fd)
  }
  try {
    options.assertExclusiveRuntimeDirectory()
    renameFileWithWindowsRetry(stagedPath, configPath)
  } finally {
    rmSync(stagedPath, { force: true })
  }
  return { host: '127.0.0.1', port, clientKey, configPath, directory }
}
