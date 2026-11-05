import { build } from 'esbuild'
import { runProcess } from '@orca/process-host'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { isDarwinNativeProbeCi, nativeProbeCliSha256 } from './claude-native-probe-cli.mjs'
import { reserveDarwinRefreshHosts } from './claude-native-darwin-refresh-hosts.mjs'
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
  const security = async (args) => {
    const result = await runProcess({
      program: '/usr/bin/security',
      args,
      timeoutMs: 3000,
      maxOutputBytes: 1024
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error('Synthetic refresh keychain operation failed')
    }
  }
  let releaseHosts
  let server
  let cleanupVerified = true
  let keychainSeeded = false
  const groups = []
  const growth = []
  let stage = 'prepare'
  try {
    releaseHosts = await reserveDarwinRefreshHosts()
    server = await createDarwinRefreshServer(canonical)
    for (let index = 0; index < 5; index++) {
      await writeFile(join(config, '.credentials.json'), credentials, { mode: 0o600 })
      await security([
        'add-generic-password',
        '-U',
        '-A',
        '-s',
        service,
        '-a',
        userInfo().username,
        '-w',
        credentials,
        environment.keychain
      ])
      keychainSeeded = true
      let group
      let closed
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
            return api.runAgentModelCatalogListing(
              {
                ...launch,
                env: {
                  ...launch.env,
                  HOME: home,
                  NODE_EXTRA_CA_CERTS: server.certificate,
                  ANTHROPIC_BASE_URL: 'https://claude.fedstart.com',
                  CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://claude.fedstart.com'
                },
                envToDelete: launch.envToDelete?.filter(
                  (name) => !['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_CUSTOM_OAUTH_URL'].includes(name)
                )
              },
              {
                ...options,
                inheritedEnv: {
                  PATH: process.env.PATH,
                  USER: userInfo().username,
                  LANG: 'en_US.UTF-8',
                  TMPDIR: home
                },
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
              }
            )
          }
        }
      )
      stage = 'group-proof'
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
      growth.push(await api.measureOwnedNativeProbeDirectory(home))
    }
    stage = 'whole-home-growth'
    if (
      server.counts.refresh !== 5 ||
      server.counts.inference !== 0 ||
      new Set(growth.map((value) => value.files)).size !== 1 ||
      Math.max(...growth.map((value) => value.bytes)) -
        Math.min(...growth.map((value) => value.bytes)) >=
        4096
    ) {
      throw new Error('Synthetic refresh requests or whole-HOME growth exceeded contract')
    }
    const receipt = {
      passed: true,
      nativeVersion: '2.1.318',
      sha256: await nativeProbeCliSha256(executable),
      realCredentials: false,
      executions: 5,
      requests: server.counts,
      groups,
      growth,
      accessOnlyProjection: true,
      isolatedKeychain: true,
      loopbackOnlyNative: true
    }
    await writeFile(
      join(output, 'fresh-refresh-authority.json'),
      JSON.stringify(receipt, null, 2),
      { mode: 0o600 }
    )
    return receipt
  } catch (error) {
    await writeFile(
      join(output, 'fresh-refresh-diagnostic.json'),
      JSON.stringify(
        {
          stage,
          completed: groups.length,
          requests: server?.counts ?? null,
          groups,
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
    await server?.close()
    if (cleanupVerified) {
      try {
        if (keychainSeeded) {
          await security([
            'delete-generic-password',
            '-s',
            service,
            '-a',
            userInfo().username,
            environment.keychain
          ])
        }
      } finally {
        await releaseHosts?.()
      }
    }
  }
}
