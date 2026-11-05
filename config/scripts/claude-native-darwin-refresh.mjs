import { build } from 'esbuild'
import process from 'node:process'
import { runProcess } from '@orca/process-host'
import { mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { join, relative, isAbsolute, delimiter } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { isDarwinNativeProbeCi, nativeProbeCliSha256 } from './claude-native-probe-cli.mjs'
import {
  readNativeRefreshDiagnosticSummary,
  summarizeNativeRefreshCommand
} from './claude-native-refresh-diagnostics.mjs'
import { createNativeRefreshConnectProxy } from './claude-native-refresh-connect-proxy.mjs'
import { probeDarwinRefreshSecurity } from './claude-native-darwin-security-probe.mjs'
import { prepareDarwinSecurityDiagnostic } from './claude-native-darwin-security-shim.mjs'
import { probeDarwinSecurityWrites } from './claude-native-darwin-security-write-probe.mjs'
import {
  createDarwinRefreshServer,
  EXPIRED_ACCESS,
  FRESH_ACCESS,
  EXPIRED_REFRESH,
  ROTATED_REFRESH
} from './claude-native-darwin-refresh-server.mjs'

/** Invoke only inside the existing qualifier's fake-only environment, before its restoration. */
export async function runDarwinNativeRefreshQualification({
  root,
  output,
  environment,
  executable
}) {
  if (!isDarwinNativeProbeCi()) {
    throw new Error('Native refresh qualification requires isolated Darwin CI')
  }
  const canonical = await realpath(root)
  for (const path of [environment.keychain, environment.sandbox]) {
    const rel = relative(canonical, await realpath(path))
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Native refresh environment must belong to the fake CI root')
    }
  }
  const home = join(canonical, 'refresh-home')
  const config = join(home, 'config')
  const writer = join(home, 'writer')
  await mkdir(config, { recursive: true, mode: 0o700 })
  const production = join(canonical, 'refresh-production.mjs')
  await build({
    stdin: {
      contents:
        "export {refreshClaudeNativeAccess} from './src/main/claude-accounts/claude-native-refresh-authority.ts';" +
        "export {runAgentModelCatalogListing} from './src/main/native-chat/agent-model-catalog/agent-model-catalog-probe-runner.ts';" +
        "export {readClaudeOAuthCredentials} from './src/main/rate-limits/claude-oauth-credentials.ts';" +
        "export {readBoundedClaudeProfileJson} from './src/main/claude-accounts/claude-native-access.ts';" +
        "export {claudeKeychainService} from './src/main/claude-accounts/keychain.ts';" +
        "export {measureOwnedNativeProbeDirectory} from './src/main/claude-accounts/claude-native-probe-test-growth.ts';",
      resolveDir: process.cwd()
    },
    outfile: production,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import {createRequire as opkaRefreshCreateRequire} from 'node:module'; import {fileURLToPath as opkaRefreshFileURLToPath} from 'node:url'; import {dirname as opkaRefreshDirname} from 'node:path'; const require=opkaRefreshCreateRequire(import.meta.url); const __filename=opkaRefreshFileURLToPath(import.meta.url); const __dirname=opkaRefreshDirname(__filename);"
    },
    external: ['electron'],
    conditions: ['orca-source'],
    logLevel: 'silent'
  })
  const api = await import(pathToFileURL(production).href)
  const identity = {
    accountUuid: randomUUID(),
    organizationUuid: randomUUID(),
    emailAddress: 'synthetic@example.invalid'
  }
  const state = JSON.stringify({
    oauthAccount: identity,
    hasCompletedOnboarding: true,
    projects: { [config]: { hasTrustDialogAccepted: true } }
  })
  for (const name of ['.claude.json', '.claude-custom-oauth.json']) {
    await writeFile(join(config, name), state, { mode: 0o600 })
  }
  const credentials = JSON.stringify({
    claudeAiOauth: {
      accessToken: EXPIRED_ACCESS,
      refreshToken: EXPIRED_REFRESH,
      expiresAt: Date.now() - 60000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max'
    }
  })
  const service = api.claudeKeychainService(config)
  const absent = await runProcess({
    program: '/usr/bin/security',
    args: [
      'find-generic-password',
      '-s',
      service,
      '-a',
      userInfo().username,
      '-w',
      environment.keychain
    ],
    timeoutMs: 3000,
    maxOutputBytes: 65536
  })
  if (absent.code !== 44 || absent.timedOut || absent.outputTruncated) {
    throw new Error('Synthetic source must start without a manual scoped Keychain item')
  }
  let proxy
  let server
  let securityDiagnostic
  let cleanupVerified = true
  const groups = []
  const growth = []
  const closureProofs = []
  const sourceObservations = []
  const debugObservations = []
  const commandObservations = []
  let securityPreflight = []
  const securityWritePreflight = []
  let securityWriteDefaultMatched = false
  const debugPath = join(home, 'native-refresh-debug.log')
  let stage = 'prepare'
  const closeFixture = async () => {
    try {
      await proxy?.close()
      await server?.close()
    } catch (error) {
      if (!cleanupVerified) {
        error.nativeCleanupUnverifiable = true
      }
      throw error
    }
  }
  try {
    securityDiagnostic = await prepareDarwinSecurityDiagnostic(canonical)
    server = await createDarwinRefreshServer(canonical)
    proxy = await createNativeRefreshConnectProxy(server.port)
    for (let index = 0; index < 5; index++) {
      await writeFile(join(config, '.credentials.json'), credentials, { mode: 0o600 })
      let group
      let closed
      const verifyClosed = async () => {
        if (!group || closed?.root !== 'exited') {
          throw new Error('Synthetic native refresh group closure is unverifiable')
        }
        try {
          await readFile(join(writer, 'writer-owner.json'))
          throw new Error('Synthetic native refresh writer receipt remains')
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error
          }
        }
        try {
          process.kill(-group.pgid, 0)
          throw new Error('Synthetic native refresh process group remains live')
        } catch (error) {
          if (error.code !== 'ESRCH') {
            throw error
          }
        }
        cleanupVerified = true
        closureProofs.push({
          root: closed.root,
          tree: closed.tree,
          groupExited: true,
          writerReceiptAbsent: true
        })
      }
      stage = 'native-refresh'
      const snapshot = await api.refreshClaudeNativeAccess(
        {
          configDir: config,
          writerDirectory: writer,
          expectedIdentity: identity,
          qualifiedVersion: '2.1.318',
          launch: {
            command: '/usr/bin/sandbox-exec',
            args: ['-f', environment.sandbox, executable],
            cwd: config
          },
          assertExclusive() {}
        },
        {
          run: async (launch, options) => {
            cleanupVerified = false
            try {
              const fixtureLaunch = {
                ...launch,
                args: [...launch.args, '--debug-file', debugPath],
                env: {
                  ...launch.env,
                  HOME: home,
                  NODE_EXTRA_CA_CERTS: server.certificate,
                  HTTPS_PROXY: proxy.url,
                  https_proxy: proxy.url,
                  HTTP_PROXY: proxy.url,
                  http_proxy: proxy.url,
                  ALL_PROXY: proxy.url,
                  all_proxy: proxy.url,
                  NO_PROXY: '',
                  no_proxy: ''
                },
                envToDelete: launch.envToDelete
              }
              const inheritedEnv = {
                PATH: [securityDiagnostic.directory, process.env.PATH ?? ''].join(delimiter),
                USER: userInfo().username,
                LANG: 'en_US.UTF-8',
                TMPDIR: home
              }
              if (securityPreflight.length === 0) {
                stage = 'security-preflight'
                const env = { ...inheritedEnv, ...fixtureLaunch.env }
                for (const name of fixtureLaunch.envToDelete ?? []) {
                  delete env[name]
                }
                try {
                  securityPreflight = await probeDarwinRefreshSecurity({
                    sandbox: environment.sandbox,
                    keychain: environment.keychain,
                    env
                  })
                  if (
                    securityPreflight.some(
                      (value) => value.code !== 44 || value.timedOut || value.outputTruncated
                    )
                  ) {
                    throw new Error(
                      'Synthetic OS Security lookup preflight refused before native usage'
                    )
                  }
                  stage = 'security-write-preflight'
                  await probeDarwinSecurityWrites({
                    sandbox: environment.sandbox,
                    keychain: environment.keychain,
                    env,
                    onObservation: (value) => securityWritePreflight.push(value),
                    onDefaultVerified: () => {
                      securityWriteDefaultMatched = true
                    }
                  })
                  if (
                    securityWritePreflight.some(
                      (value) =>
                        value.write.code !== 0 ||
                        value.write.timedOut ||
                        !value.readMatched ||
                        !value.cleanupVerified
                    )
                  ) {
                    throw new Error('Synthetic Security write control refused before native usage')
                  }
                } catch (preflightError) {
                  options.onNotStarted?.()
                  try {
                    await readFile(join(writer, 'writer-owner.json'))
                    throw new Error('Unverified unstarted native writer')
                  } catch (error) {
                    if (error.code !== 'ENOENT') {
                      throw error
                    }
                  }
                  cleanupVerified = preflightError.nativeCleanupUnverifiable !== true
                  throw preflightError
                }
                stage = 'native-refresh'
              }
              const stdout = await api.runAgentModelCatalogListing(fixtureLaunch, {
                ...options,
                inheritedEnv,
                onGroupProven(value) {
                  group = value
                  options.onGroupProven?.(value)
                },
                onClosed(value) {
                  closed = value
                  options.onClosed?.(value)
                },
                onNotStarted() {
                  options.onNotStarted?.()
                }
              })
              commandObservations.push(summarizeNativeRefreshCommand(stdout))
              return stdout
            } finally {
              try {
                if (!cleanupVerified) {
                  await verifyClosed()
                }
              } finally {
                debugObservations.push(await readNativeRefreshDiagnosticSummary(debugPath))
                if (cleanupVerified) {
                  await rm(debugPath, { force: true })
                }
              }
            }
          }
        }
      )
      stage = 'access-projection'
      if (
        snapshot.access.accessToken !== FRESH_ACCESS ||
        snapshot.identity.accountUuid !== identity.accountUuid ||
        snapshot.identity.organizationUuid !== identity.organizationUuid ||
        JSON.stringify(snapshot).includes(ROTATED_REFRESH) ||
        Object.hasOwn(snapshot.access, 'refreshToken')
      ) {
        throw new Error(
          'Synthetic native refresh projection violated identity/access-only contract'
        )
      }
      groups.push({
        proven: true,
        root: closed.root,
        tree: closed.tree,
        groupExited: true,
        writerReceiptAbsent: true
      })
      const selected = await api.readClaudeOAuthCredentials({
        credentialsFileConfigDir: config,
        keychainConfigDir: config,
        includeNativeAccess: true
      })
      const fileAccess = api.readBoundedClaudeProfileJson(
        join(config, '.credentials.json')
      ).claudeAiOauth
      sourceObservations.push({
        source: selected.source,
        freshAccessMatched: selected.nativeAccess?.accessToken === FRESH_ACCESS,
        fileFreshAccessMatched: fileAccess?.accessToken === FRESH_ACCESS,
        fileRefreshRotated: fileAccess?.refreshToken === ROTATED_REFRESH
      })
      growth.push(await api.measureOwnedNativeProbeDirectory(home))
    }
    stage = 'whole-home-growth'
    if (
      proxy.counts.accepted === 0 ||
      proxy.counts.bytes === 0 ||
      server.counts.refresh !== 5 ||
      server.counts.inference !== 0 ||
      new Set(growth.map((value) => value.files)).size !== 1 ||
      Math.max(...growth.map((value) => value.bytes)) -
        Math.min(...growth.map((value) => value.bytes)) >=
        4096
    ) {
      throw new Error('Synthetic refresh requests or whole-HOME growth exceeded contract')
    }
    stage = 'proxy-close'
    const proxyCounts = proxy.counts
    const proxyClosure = await proxy.close()
    proxy = undefined
    const receipt = {
      passed: true,
      nativeVersion: '2.1.318',
      sha256: await nativeProbeCliSha256(executable),
      realCredentials: false,
      executions: 5,
      requests: server.counts,
      proxy: proxyCounts,
      proxyClosure,
      groups,
      closureProofs,
      sourceObservations,
      debugObservations,
      commandObservations,
      securityPreflight,
      securityWritePreflight,
      securityWriteDefaultMatched,
      securityDiagnostic: await securityDiagnostic.read(),
      diagnosticOnly: true,
      growth,
      accessOnlyProjection: true,
      isolatedKeychain: true,
      loopbackOnlyNative: true,
      nativeDefaultAuthNamespace: true
    }
    await writeFile(
      join(output, 'fresh-refresh-authority.json'),
      JSON.stringify(receipt, null, 2),
      { mode: 0o600 }
    )
    return receipt
  } catch (error) {
    const observation = await api
      .readClaudeOAuthCredentials({
        credentialsFileConfigDir: config,
        keychainConfigDir: config,
        includeNativeAccess: true
      })
      .then(
        (value) => ({
          source: value.source,
          unavailable: value.unavailable === true,
          nativeAccessKnown: Boolean(value.nativeAccess),
          freshAccessMatched: value.nativeAccess?.accessToken === FRESH_ACCESS,
          expiryFresh: (value.nativeAccess?.expiresAt ?? 0) > Date.now() + 30000
        }),
        () => ({ unavailable: true })
      )
    let fileObservation = { readable: false }
    try {
      const access = api.readBoundedClaudeProfileJson(
        join(config, '.credentials.json')
      ).claudeAiOauth
      fileObservation = {
        readable: true,
        freshAccessMatched: access?.accessToken === FRESH_ACCESS,
        refreshRotated: access?.refreshToken === ROTATED_REFRESH,
        fieldNames: Object.keys(access ?? {})
          .filter((name) => /^[a-zA-Z]{1,40}$/.test(name))
          .slice(0, 20)
      }
    } catch {}
    let profileObservation = { readable: false }
    try {
      const profile = api.readBoundedClaudeProfileJson(join(config, '.claude.json')).oauthAccount
      profileObservation = {
        readable: true,
        accountMatched: profile?.accountUuid === identity.accountUuid,
        organizationMatched: profile?.organizationUuid === identity.organizationUuid,
        emailMatched: profile?.emailAddress === identity.emailAddress
      }
    } catch {}
    await writeFile(
      join(output, 'fresh-refresh-diagnostic.json'),
      JSON.stringify(
        {
          stage,
          observation,
          fileObservation,
          debugObservations,
          commandObservations,
          securityPreflight,
          securityWritePreflight,
          securityWriteDefaultMatched,
          securityDiagnostic: await securityDiagnostic
            ?.read()
            .catch(() => ({ unverifiable: true })),
          diagnosticOnly: true,
          profileObservation,
          completed: groups.length,
          requests: server?.counts ?? null,
          proxy: proxy?.counts ?? null,
          groups,
          closureProofs,
          growth,
          cleanupVerified
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
    if (!cleanupVerified) {
      error.nativeCleanupUnverifiable = true
    }
    throw error
  } finally {
    await closeFixture()
  }
}
