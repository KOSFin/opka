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
import {
  assertDarwinRefreshWriterAbsent,
  cancelUnstartedDarwinRefresh
} from './claude-native-darwin-refresh-writer.mjs'
import { probeDarwinRefreshPreflight } from './claude-native-darwin-refresh-preflight.mjs'
import {
  qualifyDarwinRefreshCache,
  assertDarwinRefreshAccess
} from './claude-native-darwin-refresh-cache.mjs'
import {
  prepareDarwinRefreshGlobalSentinels,
  assertDarwinRefreshKeychainSelection,
  assertDarwinRefreshFileUnchanged
} from './claude-native-darwin-refresh-global.mjs'
import { runDarwinRefreshSecurityCommand } from './claude-native-darwin-refresh-security-command.mjs'
import { prepareDarwinSecurityDiagnostic } from './claude-native-darwin-security-shim.mjs'
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
  if (!environment.nativeUserHome || !isAbsolute(environment.nativeUserHome)) {
    throw new Error('Synthetic execution host HOME is unavailable')
  }
  const nativeUserHome = await realpath(environment.nativeUserHome)
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
  const fileRefresh = 'synthetic-adversarial-file-refresh'
  const keychainCredentials = JSON.stringify({
    claudeAiOauth: {
      accessToken: EXPIRED_ACCESS,
      refreshToken: EXPIRED_REFRESH,
      expiresAt: Date.now() - 60000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max'
    }
  })
  const credentials = keychainCredentials
    .replace(EXPIRED_REFRESH, fileRefresh)
    .replace(EXPIRED_ACCESS, 'sk-ant-oat01-synthetic-adversarial-file')
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
  let globalSentinels
  let sourceSeeded = false
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
  let securityWriteDefaultControl = null
  let keychainDomain = null
  let nativeExecutions = 0
  let initialGrowth = null
  const cancelBeforeSpawn = async (options) => {
    try {
      await cancelUnstartedDarwinRefresh(options, writer)
    } catch (error) {
      cleanupVerified = false
      throw error
    }
  }
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
  const closeOwnedFixture = async () => {
    await closeFixture()
    if (cleanupVerified) {
      await globalSentinels?.dispose()
      if (sourceSeeded) {
        const { result: deleted, terminationObserved } = await runDarwinRefreshSecurityCommand([
          'delete-generic-password',
          '-s',
          service,
          '-a',
          userInfo().username,
          environment.keychain
        ])
        if (
          deleted.code !== 0 ||
          deleted.timedOut ||
          deleted.outputTruncated ||
          !terminationObserved
        ) {
          throw new Error('Synthetic Keychain source cleanup is unverified')
        }
      }
    }
  }
  try {
    globalSentinels = await prepareDarwinRefreshGlobalSentinels(nativeUserHome)
    cleanupVerified = false
    const { result: seed, terminationObserved } = await runDarwinRefreshSecurityCommand([
      'add-generic-password',
      '-U',
      '-A',
      '-s',
      service,
      '-a',
      userInfo().username,
      '-w',
      keychainCredentials,
      environment.keychain
    ])
    if (seed.code !== 0 || seed.timedOut || seed.outputTruncated || !terminationObserved) {
      throw new Error('Synthetic scoped Keychain source seed failed')
    }
    sourceSeeded = true
    cleanupVerified = true
    securityDiagnostic = await prepareDarwinSecurityDiagnostic(canonical)
    server = await createDarwinRefreshServer(canonical)
    proxy = await createNativeRefreshConnectProxy(server.port)
    await writeFile(join(config, '.credentials.json'), credentials, { mode: 0o600 })
    initialGrowth = await api.measureOwnedNativeProbeDirectory(home)
    for (let index = 0; index < 1; index++) {
      let group
      let closed
      let forwardedClose
      let notStarted = false
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
          nativeUserHome,
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
                  const preflight = await probeDarwinRefreshPreflight({
                    sandbox: environment.sandbox,
                    keychain: environment.keychain,
                    env,
                    onDefaultObservation: (value) => {
                      securityWriteDefaultControl = value
                    }
                  })
                  if (preflight.domain.mode !== 'owned-default') {
                    throw new Error(
                      'Native host HOME does not share the owned fake Keychain default'
                    )
                  }
                  keychainDomain = preflight.domain
                  securityPreflight = preflight.lookups
                  securityWritePreflight.push(...preflight.writes)
                  securityWriteDefaultMatched = preflight.ownedDefault
                } catch (preflightError) {
                  await cancelBeforeSpawn(options)
                  cleanupVerified = preflightError.nativeCleanupUnverifiable !== true
                  throw preflightError
                }
                stage = 'native-refresh'
              }
              if (options.signal?.aborted) {
                await cancelBeforeSpawn(options)
                cleanupVerified = true
                throw new Error('Synthetic native refresh stopped before spawn')
              }
              nativeExecutions++
              const stdout = await api.runAgentModelCatalogListing(fixtureLaunch, {
                ...options,
                inheritedEnv,
                onGroupProven(value) {
                  group = value
                  options.onGroupProven?.(value)
                },
                onClosed(value) {
                  closed = value
                  forwardedClose = options.onClosed?.(value)
                  return forwardedClose
                },
                onNotStarted() {
                  notStarted = true
                  forwardedClose = options.onNotStarted?.()
                  return forwardedClose
                }
              })
              commandObservations.push(summarizeNativeRefreshCommand(stdout))
              return stdout
            } catch (commandError) {
              commandObservations.push({
                controlledStopped: commandError.reason === 'stopped',
                successfulExit: false
              })
              throw commandError
            } finally {
              try {
                await forwardedClose
                if (!cleanupVerified) {
                  if (notStarted && !group) {
                    await assertDarwinRefreshWriterAbsent(writer)
                    cleanupVerified = true
                  } else {
                    await verifyClosed()
                  }
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
      assertDarwinRefreshAccess(snapshot, {
        identity,
        accessToken: FRESH_ACCESS,
        refreshToken: ROTATED_REFRESH
      })
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
      assertDarwinRefreshKeychainSelection(selected, fileAccess, {
        freshAccess: FRESH_ACCESS,
        fileRefresh
      })
      await assertDarwinRefreshFileUnchanged(join(config, '.credentials.json'), credentials)
      await globalSentinels.assertUnchanged()
      growth.push(await api.measureOwnedNativeProbeDirectory(home))
    }
    stage = 'cached-access'
    const cachedGrowth = await qualifyDarwinRefreshCache({
      initial: growth[0],
      read: () =>
        api.refreshClaudeNativeAccess(
          {
            configDir: config,
            nativeUserHome,
            writerDirectory: writer,
            expectedIdentity: identity,
            qualifiedVersion: '2.1.318',
            launch: { command: executable, args: [], cwd: config },
            assertExclusive() {}
          },
          {
            run: async (_launch, options) => {
              await cancelBeforeSpawn(options)
              throw new Error('Cached read attempted another native actor')
            }
          }
        ),
      validate: (snapshot) =>
        assertDarwinRefreshAccess(snapshot, {
          identity,
          accessToken: FRESH_ACCESS,
          refreshToken: ROTATED_REFRESH
        }),
      measure: async () => {
        await assertDarwinRefreshFileUnchanged(join(config, '.credentials.json'), credentials)
        return api.measureOwnedNativeProbeDirectory(home)
      }
    })
    growth.push(...cachedGrowth)
    await globalSentinels.assertUnchanged()
    stage = 'whole-home-growth'
    if (
      proxy.counts.accepted === 0 ||
      proxy.counts.bytes === 0 ||
      server.counts.refresh !== 1 ||
      nativeExecutions !== 1 ||
      groups.length !== 1 ||
      server.counts.inference !== 0 ||
      new Set(growth.map((value) => value.files)).size !== 1 ||
      growth.some((value) => value.files !== growth[0].files || value.bytes !== growth[0].bytes)
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
      executions: nativeExecutions,
      cachedReads: 4,
      initialGrowth,
      keychainDomain,
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
      securityWriteDefaultControl,
      securityDiagnostic: await securityDiagnostic.read(),
      diagnosticOnly: true,
      growth,
      accessOnlyProjection: true,
      isolatedKeychain: true,
      loopbackOnlyNative: true,
      nativeDefaultAuthNamespace: keychainDomain?.mode === 'owned-default',
      keychainNamespaceMode: keychainDomain?.mode ?? 'unverifiable',
      fileFallbackQualified: false,
      keychainRefreshQualified: true,
      adversarialFileBytesUnchanged: true,
      globalSentinelsUnchanged: true,
      growthScope: 'owned-source-home'
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
          securityWriteDefaultControl,
          securityDiagnostic: await securityDiagnostic
            ?.read()
            .catch(() => ({ unverifiable: true })),
          diagnosticOnly: true,
          profileObservation,
          completed: groups.length,
          nativeExecutions,
          keychainDomain,
          initialGrowth,
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
    await closeOwnedFixture()
  }
}
