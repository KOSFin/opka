import { assertNativeClaudeAccountUnused } from './native-claude-routing-ownership'
import { createClaudeNativePoolScopeRegistry } from './claude-native-pool-scope-registry'
import type { OrchestrationDb } from './orchestration/db/orchestration-db'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { resolveClaudeCommand } from '../codex-cli/command'
import {
  resolveUnwrappedNativeCliCommand,
  nativeCliExecutableGeneration
} from '../../shared/native-cli-unwrapped-command'
import { probeRecentClaudeCliVersion } from '../claude/claude-hook-event-versions'
import {
  ClaudeNativeRefreshSources,
  type ClaudeNativeRefreshSourceStatus
} from '../claude-accounts/claude-native-refresh-sources'
import type { ClaudeNativeCodeWriter } from '../claude-accounts/claude-native-source-login'
import type { NativeClaudeRefreshSignInReference } from '../../shared/native-claude-refresh-source'

type SignIn = NativeClaudeRefreshSignInReference & {
  link: string | null
  state: ClaudeNativeRefreshSourceStatus['state']
  submit?: ClaudeNativeCodeWriter
  codeDigest?: string
  submission?: Promise<void>
  done: Promise<void>
}
type ClaudeNativeLaunchContext = {
  dataRoot: string
  userHome: string
  userConfigDir?: string
  assertExclusive: () => void
  resolveHookLaunch?: () => { command: string; args: string[] } | null
}
type Entry = {
  sources: ClaudeNativeRefreshSources
  signIns: Map<string, SignIn>
  detachRetirement?: () => void
  detachUsage?: () => void
  launch: ClaudeNativeLaunchContext
  poolScopes?: ReturnType<typeof createClaudeNativePoolScopeRegistry>
}
const hosts = new WeakMap<object, Entry>()

export function configureRuntimeClaudeNativeSources(
  runtime: object,
  options: Omit<
    ConstructorParameters<typeof ClaudeNativeRefreshSources>[0],
    'resolveLaunch' | 'userHome'
  > & {
    resolveLaunch?: ConstructorParameters<typeof ClaudeNativeRefreshSources>[0]['resolveLaunch']
    userHome?: string
    resolveHookLaunch?: ClaudeNativeLaunchContext['resolveHookLaunch']
  }
): void {
  if (hosts.has(runtime)) {
    throw new Error('Claude native sources are already configured.')
  }
  const sources = new ClaudeNativeRefreshSources({
    ...options,
    userHome: options.userHome ?? homedir(),
    resolveLaunch:
      options.resolveLaunch ??
      (async () => {
        const command = resolveUnwrappedNativeCliCommand('claude', resolveClaudeCommand())
        return {
          command,
          args: [],
          version:
            (await probeRecentClaudeCliVersion(command, nativeCliExecutableGeneration(command))) ??
            'unknown'
        }
      })
  })
  hosts.set(runtime, {
    sources,
    signIns: new Map(),
    detachUsage: options.accounts.setNativeUsagePreparationResolver?.((id, signal) =>
      sources.usagePreparation(id, signal)
    ),
    detachRetirement: options.accounts.setNativeRoutingRetirement?.({
      cancel: (accountId) => sources.cancelSignIn(accountId),
      retire: async (accountId) => {
        assertNativeClaudeAccountUnused(runtime, accountId)
        await sources.retireFromOwnedMutation(accountId)
      }
    }),
    launch: {
      dataRoot: options.dataRoot,
      userHome: options.userHome ?? homedir(),
      userConfigDir: options.userConfigDir,
      assertExclusive: () => sources.assertOwned(),
      resolveHookLaunch: options.resolveHookLaunch
    }
  })
}
export function getRuntimeClaudeNativeLaunchContext(
  runtime: object
): ClaudeNativeLaunchContext | null {
  const entry = hosts.get(runtime)
  if (!entry) {
    return null
  }
  entry.sources.assertOwned()
  return entry.launch
}
export function getRuntimeClaudeNativeSources(runtime: object): ClaudeNativeRefreshSources | null {
  return hosts.get(runtime)?.sources ?? null
}
export function registerRuntimeClaudeNativePoolScope(
  runtime: object & { getOrchestrationDb(): OrchestrationDb }
) {
  const entry = requireEntry(runtime)
  entry.poolScopes ??= createClaudeNativePoolScopeRegistry({
    db: runtime.getOrchestrationDb(),
    sources: entry.sources,
    dataRoot: entry.launch.dataRoot
  })
  return entry.poolScopes.registerScope()
}
export async function shutdownRuntimeClaudeNativeSources(runtime: object): Promise<void> {
  const entry = hosts.get(runtime)
  if (!entry) {
    return
  }
  await entry.sources.shutdown()
  await Promise.allSettled([...entry.signIns.values()].map((signIn) => signIn.done))
  entry.detachUsage?.()
  entry.detachRetirement?.()
  hosts.delete(runtime)
}
function requireEntry(runtime: object): Entry {
  const entry = hosts.get(runtime)
  if (!entry) {
    throw new Error('Claude native source capability is unavailable.')
  }
  entry.sources.assertOwned()
  return entry
}
function requireSignIn(runtime: object, reference: NativeClaudeRefreshSignInReference): SignIn {
  const entry = requireEntry(runtime).signIns.get(reference.accountId)
  if (!entry || entry.signInId !== reference.signInId) {
    throw new Error('Claude native sign-in ownership is unavailable.')
  }
  return entry
}
const result = (entry: SignIn) => ({
  link: entry.link,
  state: entry.state,
  ...(entry.submit ? { requiresCode: true as const } : {})
})

export async function listRuntimeClaudeNativeSources(runtime: object) {
  const entry = requireEntry(runtime)
  const accounts = entry.sources.accountIds()
  if (accounts.length > 128) {
    throw new Error('Claude native source inventory requires review.')
  }
  return {
    accounts: await Promise.all(
      accounts.map(async (accountId) => ({ accountId, ...(await entry.sources.state(accountId)) }))
    )
  }
}
export function beginRuntimeClaudeNativeSignIn(
  runtime: object,
  accountId: string
): NativeClaudeRefreshSignInReference {
  const entry = requireEntry(runtime)
  if (!entry.sources.accountIds().includes(accountId)) {
    throw new Error('Claude native source identity is unavailable.')
  }
  if (
    entry.signIns.get(accountId)?.state === 'signing-in' ||
    (entry.signIns.size >= 128 && !entry.signIns.has(accountId))
  ) {
    throw new Error('Claude native sign-in is already pending or unavailable.')
  }
  const signIn: SignIn = {
    accountId,
    signInId: randomUUID(),
    link: null,
    state: 'signing-in',
    done: Promise.resolve()
  }
  entry.signIns.set(accountId, signIn)
  signIn.done = Promise.resolve()
    .then(() =>
      entry.sources.signIn(
        accountId,
        (link) => {
          if (entry.signIns.get(accountId) === signIn && signIn.state === 'signing-in') {
            signIn.link = link
          }
        },
        (submit) => {
          if (entry.signIns.get(accountId) === signIn && signIn.state === 'signing-in') {
            signIn.submit = submit ?? undefined
          }
        }
      )
    )
    .then(
      (state) => {
        signIn.state = state.state
      },
      () => {
        signIn.state = 'needs-sign-in'
      }
    )
    .finally(() => {
      signIn.submit = undefined
      signIn.link = null
    })
  return { accountId, signInId: signIn.signInId }
}
export function runtimeClaudeNativeSignInLink(
  runtime: object,
  reference: NativeClaudeRefreshSignInReference
) {
  return result(requireSignIn(runtime, reference))
}
export async function submitRuntimeClaudeNativeCode(
  runtime: object,
  reference: NativeClaudeRefreshSignInReference,
  code: string
) {
  code = code.trim()
  if (code.length > 4096 || !/^[^\s#\0]+#[^\s#\0]+$/.test(code)) {
    throw new Error('Claude native authorization input is unavailable.')
  }
  const signIn = requireSignIn(runtime, reference)
  const digest = createHash('sha256').update(code).digest('hex')
  if (signIn.codeDigest !== undefined) {
    if (signIn.codeDigest !== digest) {
      throw new Error('Claude native authorization input is unavailable.')
    }
    await signIn.submission
    return result(signIn)
  }
  if (signIn.state !== 'signing-in' || !signIn.submit) {
    throw new Error('Claude native authorization input is unavailable.')
  }
  signIn.codeDigest = digest
  signIn.submission = signIn.submit(code)
  await signIn.submission
  return result(signIn)
}
export async function cancelRuntimeClaudeNativeSignIn(
  runtime: object,
  reference: NativeClaudeRefreshSignInReference
) {
  const entry = requireEntry(runtime)
  const signIn = requireSignIn(runtime, reference)
  entry.sources.cancelSignIn(reference.accountId)
  await signIn.done
  return result(signIn)
}
