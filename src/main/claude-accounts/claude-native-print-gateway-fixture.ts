import { createClaudeNativePrintGatewayEndpoint } from './claude-native-print-gateway-endpoint'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { vi } from 'vitest'
import * as nativeLaunch from '../runtime/native-cli-account-launch'
import { createNativeClaudeWrapperTestHost } from './claude-native-wrapper-test-host'
import { buildClaudeNativeWrapperTestBridge } from './claude-native-wrapper-test-bridge'
import { installClaudeNativeCoverageModule } from './claude-native-coverage-install'
import { agentHookServer } from '../agent-hooks/server'
import { NATIVE_CLAUDE_ROUTING_KEY_ENV } from '../../shared/native-claude-hook'
import {
  dispatchNativeClaudeCoverage,
  registerNativeClaudeHookSession
} from '../runtime/native-claude-hook-sessions'
import { createNativeClaudeStdioSessionBoundary } from '../runtime/native-claude-stdio-session-boundary'
import {
  readNativeCliStdioOwner,
  readNativeCliStdioObservationOwner
} from '../runtime/native-cli-stdio-owner'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'
import { stopNativeCliStdioSessions } from '../runtime/native-cli-stdio-host'
import {
  getRuntimeClaudeNativeSources,
  registerRuntimeClaudeNativePoolScope
} from '../runtime/runtime-claude-native-sources'
import { accountPoolCandidates } from '../runtime/account-pool-candidates'
import { readyNativeClaudePoolCandidates } from '../runtime/native-claude-pool-candidates'
import { acquireClaudeNativeScopedAssignment } from '../runtime/claude-native-scoped-assignment'
import { readClaudeNativeRejectedRequestBoundary } from './claude-native-gateway-boundary'
import { getMainHttpClient, setMainHttpClient } from '../network/http-client'

/** Genuine transport/lease/status with fake source accounts and no native provider credentials. */
export async function createClaudeNativePrintGatewayFixture(executable: string) {
  const root = await mkdtemp(join(tmpdir(), 'opka-native-print-gateway-'))
  const previousHttp = getMainHttpClient()
  vi.stubEnv('HOME', root)
  await agentHookServer.start({ env: 'production', userDataPath: join(root, 'hooks') })
  const launchId = randomUUID(),
    capability = `sk-ant-oat01-${randomBytes(32).toString('hex')}`
  const home = join(root, 'opaque-native-home'),
    bridge = join(root, 'private-hook.mjs')
  let host: Awaited<ReturnType<typeof createNativeClaudeWrapperTestHost>> | undefined
  let alive = true
  const fake = createClaudeNativePrintGatewayEndpoint({
    capability,
    readAccountUuid: (id) => host?.identities.find((item) => item.id === id)?.accountUuid,
    observe: (request) => {
      if (!host) {
        throw new Error('Fixture host not ready.')
      }
      return dispatchNativeClaudeCoverage(host.runtime, request)
    }
  })
  const { endpoint, observed, provider, usage } = fake

  try {
    await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
    const address = endpoint.address()
    if (!address || typeof address === 'string') {
      throw new Error('Fixture endpoint missing.')
    }
    const base = `http://127.0.0.1:${address.port}`
    await buildClaudeNativeWrapperTestBridge(bridge, base)
    host = await createNativeClaudeWrapperTestHost({
      root,
      executable,
      hookBridge: bridge,
      readPty: () => undefined,
      rotation: 'on-limit'
    })
    const runtime = host.runtime,
      db = host.db
    const store = await openTestAgentSessionRecordStore(join(root, 'journal'))
    Object.assign(runtime, {
      openAgentSessionRecordStore: async () => store,
      getNativeCliAgentSessionClaimKeyId: () => 'isolated-gateway-claim',
      getRuntimeId: () => 'isolated-gateway-host',
      openedOrchestrationDb: () => db
    })
    const sources = getRuntimeClaudeNativeSources(runtime)
    if (!sources) {
      throw new Error('Fixture source authority missing.')
    }
    const scope = registerRuntimeClaudeNativePoolScope(runtime)
    const readCandidates = () => accountPoolCandidates(runtime.getAccountsSnapshot())
    const acquireAssignment = (
      admission: Parameters<typeof acquireClaudeNativeScopedAssignment>[2]
    ) => acquireClaudeNativeScopedAssignment(db, scope, admission)
    const ready = await sources.readyAccountIds()
    const initialAssignment = acquireAssignment({
      policy: host.policy,
      candidates: readyNativeClaudePoolCandidates(readCandidates(), ready),
      preferredAccountId: 'A'
    })
    const initialAccess = await sources.refresh(initialAssignment.accountId)
    sources.assertAccountOwned(initialAssignment.accountId)
    const startedAt = Date.now()
    const boundary = createNativeClaudeStdioSessionBoundary({
      runtime,
      launchId,
      startedAt,
      isCurrent: () => alive,
      managedCoverage: true
    })
    const unregister = registerNativeClaudeHookSession(runtime, launchId, {
      capability,
      handle: async (request) => ({
        action: request.event === 'prompt' ? ('allow' as const) : ('none' as const)
      }),
      observe: async (request) => {
        await boundary.waitForOwner()
        return (await boundary.observe(request)).ack
      }
    })
    await mkdir(home, { mode: 0o700 })
    await writeFile(
      join(home, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: capability,
          expiresAt: Date.now() + 365 * 24 * 3600_000,
          scopes: ['user:inference', 'user:profile']
        }
      }),
      { mode: 0o600 }
    )
    const nativeConfig = {
      hasCompletedOnboarding: true,
      projects: { [root]: { hasTrustDialogAccepted: true } },
      oauthAccount: initialAccess.identity
    }
    await writeFile(join(home, '.claude.json'), JSON.stringify(nativeConfig), { mode: 0o600 })
    await writeFile(join(root, '.claude.json'), JSON.stringify(nativeConfig), { mode: 0o600 })
    await writeFile(join(home, 'settings.json'), '{}', { mode: 0o600 })
    const plugin = installClaudeNativeCoverageModule({
      home,
      launchId,
      launch: { command: process.execPath, args: [bridge] },
      assertExclusive: sources.assertOwned.bind(sources)
    })
    setMainHttpClient({
      proxySession: () => null,
      fetch: (url, init) => {
        if (
          ![
            'https://api.anthropic.com/api/oauth/usage',
            'https://api.anthropic.com/v1/messages',
            'https://api.anthropic.com/v1/messages?beta=true'
          ].includes(url)
        ) {
          throw new Error('Fixture refuses unqualified provider paths.')
        }
        return fetch(base + url.slice('https://api.anthropic.com'.length), init)
      }
    })
    let activeHttp = () => 0
    const readLead = () => {
      const owner = readNativeCliStdioOwner(runtime, launchId)
      return owner ? agentHookServer.readNativeClaudeStructuredLead(owner.subject) : null
    }
    const readOwner = () => {
      const owner = readNativeCliStdioOwner(runtime, launchId),
        lead = readLead()
      return owner && lead?.lead.nativeCoverage
        ? {
            identity: JSON.stringify([owner.sessionId, owner.fence, owner.process]),
            sessionId: lead.lead.nativeCoverage.sessionId
          }
        : null
    }
    const readProof = () =>
      readClaudeNativeRejectedRequestBoundary({
        readCoverage: () => readLead()?.lead.nativeCoverage,
        readOwner: () => readOwner()?.identity ?? null,
        activeHttp: () => activeHttp(),
        hasOwedBackgroundWork: () => {
          const owner = readNativeCliStdioOwner(runtime, launchId),
            sessionId = readOwner()?.sessionId
          return (
            !owner ||
            !sessionId ||
            agentHookServer.hasNativeClaudeNonRequestBackgroundWork({
              kind: 'stdio',
              owner,
              launchId,
              sessionId,
              startedAt
            })
          )
        }
      })
    return {
      root,
      home,
      base,
      launchId,
      capability,
      runtime,
      db,
      sources,
      scope,
      store,
      boundary,
      initialAccess,
      initialAssignment,
      acquireAssignment,
      readCandidates,
      readOwner,
      readCoverage: () => readLead()?.lead.nativeCoverage,
      readProof,
      policy: host.policy,
      provider,
      usage,
      observed,
      setActiveHttp: (read: () => number) => {
        activeHttp = read
      },
      interceptLaunch(baseUrl: string) {
        return vi.spyOn(nativeLaunch, 'prepareNativeCliAccountLaunch').mockResolvedValue({
          launchId,
          accountId: null,
          poolId: null,
          policyRevision: null,
          executionMode: 'inherit',
          claudePluginDirs: [plugin],
          envToDelete: [],
          env: {
            CLAUDE_CONFIG_DIR: home,
            ANTHROPIC_BASE_URL: baseUrl,
            DISABLE_AUTOUPDATER: '1',
            [NATIVE_CLAUDE_ROUTING_KEY_ENV]: capability
          }
        })
      },
      healthy: fake.healthy,
      async stopNative() {
        await stopNativeCliStdioSessions(runtime)
        return (
          !readNativeCliStdioObservationOwner(runtime, launchId) && store.listRecords().length === 0
        )
      },
      opaqueOnly: async () => {
        const value = await readFile(join(home, '.credentials.json'), 'utf8')
        return (
          value.includes(capability) &&
          !value.includes('refreshToken') &&
          !value.includes('synthetic-wrapper-')
        )
      },
      async dispose() {
        await stopNativeCliStdioSessions(runtime)
        const absent =
          !readNativeCliStdioObservationOwner(runtime, launchId) && store.listRecords().length === 0
        if (!absent) {
          throw new Error('Native fixture ownership remains unverifiable.')
        }
        alive = false
        unregister()
        boundary.retireCanonical()
        boundary.dispose()
        setMainHttpClient(previousHttp)
        endpoint.closeAllConnections()
        await new Promise<void>((resolve) => endpoint.close(() => resolve()))
        await host?.dispose()
        agentHookServer.stop()
        vi.unstubAllEnvs()
        await rm(root, { recursive: true, force: true })
      }
    }
  } catch (error) {
    setMainHttpClient(previousHttp)
    endpoint.closeAllConnections()
    await new Promise<void>((resolve) => endpoint.close(() => resolve()))
    await host?.dispose()
    agentHookServer.stop()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
