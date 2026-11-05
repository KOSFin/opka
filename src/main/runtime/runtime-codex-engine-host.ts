import { isAbsolute, join } from 'node:path'
import type { RuntimeStore } from './runtime-store-contract'
import type { AccountsSnapshot } from './runtime-account-controller'
import { accountPoolCandidates } from './account-pool-candidates'
import { getDefaultAccountPool, getAccountPoolPolicy } from './runtime-account-pool-policy'
import { CodexEngineHost, type CodexEngineHostOptions } from '../codex-routing/codex-engine-host'
import type { NativeEngineLaunch } from '../codex-routing/codex-engine-sessions'
import type { EngineGrantAccount } from '../codex-routing/engine-grant-files'
import { supportsCodexEngineGateway } from '../codex-routing/codex-engine-capability'
import { NativeCodexHistoryLedger } from './native-codex-history-ledger'
import type { CodexRoutingRemoval } from '../codex-accounts/codex-routing-removal'
import { withNativeCodexHistoryRetirement } from './native-codex-routing-ownership'
import { assertEngineWriterIdle } from '../codex-routing/engine-writer-ownership'
import { removeEngineGrantConnection } from '../codex-routing/engine-grant-files'
import { z } from 'zod'
export { supportsCodexEngineGateway } from '../codex-routing/codex-engine-capability'

type Runtime = {
  requireStore(): Pick<RuntimeStore, 'getSettings'>
  getAccountsSnapshot(): AccountsSnapshot
  getOrchestrationDb(): CodexEngineHostOptions['db']
}
export type RuntimeCodexEngineInstallOptions = Omit<
  CodexEngineHostOptions,
  | 'directory'
  | 'cacheDirectory'
  | 'db'
  | 'readAccount'
  | 'listAccounts'
  | 'readSelectionState'
  | 'withAccountMutationLease'
> & {
  /** Existing store.getProfileStorageDirectory(), never another profile's app-wide directory. */
  userDataPath: string
  assertPreferenceHomeUnused?: (home: string) => Promise<void>
  codexAccounts: {
    withRoutingMutation<T>(operation: () => Promise<T>): Promise<T>
    setRoutingRemoval(hooks: CodexRoutingRemoval): void
  }
  registerCleanup?: (cleanup: () => Promise<void>) => void
}
type Entry = {
  options: RuntimeCodexEngineInstallOptions
  host?: CodexEngineHost
  history: NativeCodexHistoryLedger
  selections: Map<
    string,
    { accountId?: string; poolId?: string; initialAccountId?: string; initialPending: boolean }
  >
}
const hosts = new WeakMap<object, Entry>()

/** Installs ownership adapters only; no asset download, process, OAuth or inference starts here. */
export function installRuntimeCodexEngineHost(
  runtime: Runtime,
  options: RuntimeCodexEngineInstallOptions
): void {
  if (!isAbsolute(options.userDataPath) || hosts.has(runtime)) {
    throw new Error('The execution-host routing installation is invalid or already owned.')
  }
  const history = new NativeCodexHistoryLedger({
    directory: join(options.userDataPath, 'codex-routing'),
    assertExclusive: options.assertExclusiveProfile
  })
  hosts.set(runtime, { options, history, selections: new Map() })
  options.codexAccounts.setRoutingRemoval({
    assertHistoryUnused: (account) =>
      history.assertUnused({ home: account.managedHomePath, accountId: account.id }),
    remove: (account, commit) =>
      withNativeCodexHistoryRetirement(account.managedHomePath, account.id, async () => {
        await options.assertPreferenceHomeUnused?.(account.managedHomePath)
        history.assertUnused({ home: account.managedHomePath, accountId: account.id })
        const host = peekRuntimeCodexEngineHost(runtime)
        if (host) {
          return host.removeNativeAccount(account.id, commit)
        }
        return options.codexAccounts.withRoutingMutation(async () => {
          assertEngineWriterIdle({
            directory: join(options.userDataPath, 'codex-routing', 'runtime'),
            assertExclusive: options.assertExclusiveProfile
          })
          const result = await commit()
          if (z.uuid().safeParse(account.id).success) {
            removeEngineGrantConnection(join(options.userDataPath, 'codex-routing'), account.id)
          }
          return result
        })
      })
  })
  options.registerCleanup?.(() => stopRuntimeCodexEngineHost(runtime))
}
export function claimRuntimeCodexHistoryHome(
  runtime: object,
  target: { home: string; accountId: string | null }
): (verdict?: 'exited' | 'unverifiable') => void {
  const entry = hosts.get(runtime)
  if (!entry) {
    throw new Error('Native history routing ownership is not configured on this execution host.')
  }
  return entry.history.claim(target)
}
export function listRuntimeCodexRoutingAccounts(
  runtime: Pick<Runtime, 'requireStore'>
): EngineGrantAccount[] {
  return (runtime.requireStore().getSettings().codexManagedAccounts ?? []).flatMap((account) =>
    account.managedHomeRuntime !== 'wsl' && account.providerAccountId && account.lastAuthenticatedAt
      ? [
          {
            id: account.id,
            providerAccountId: account.providerAccountId,
            rosterRevision: JSON.stringify([account.providerAccountId, account.lastAuthenticatedAt])
          }
        ]
      : []
  )
}
export function getRuntimeCodexEngineHost(runtime: Runtime): CodexEngineHost | null {
  if (!supportsCodexEngineGateway()) {
    return null
  }
  const entry = hosts.get(runtime)
  if (!entry) {
    return null
  }
  if (entry.host) {
    return entry.host
  }
  const listAccounts = () => listRuntimeCodexRoutingAccounts(runtime)
  entry.host = new CodexEngineHost({
    ...entry.options,
    directory: join(entry.options.userDataPath, 'codex-routing'),
    cacheDirectory: join(entry.options.userDataPath, 'codex-routing-engine-cache'),
    db: runtime.getOrchestrationDb(),
    listAccounts,
    readAccount: (id) => listAccounts().find((account) => account.id === id) ?? null,
    withAccountMutationLease: (operation) =>
      entry.options.codexAccounts.withRoutingMutation(operation),
    readSelectionState: (launchId) => {
      if (!entry.selections.has(launchId)) {
        throw new Error('Native launch ownership is unavailable.')
      }
      const context = entry.selections.get(launchId)
      if (!context) {
        throw new Error('Native launch selection is unavailable.')
      }
      const explicit = context.accountId
      const savedPolicy = explicit
        ? undefined
        : context.poolId
          ? getAccountPoolPolicy(runtime, context.poolId)
          : getDefaultAccountPool(runtime, 'codex')
      const policy =
        context.initialPending && context.initialAccountId && savedPolicy
          ? {
              ...savedPolicy,
              applyToNewWork: true,
              members: savedPolicy.members.filter(
                (member) => member.accountId === context.initialAccountId
              )
            }
          : savedPolicy
      return {
        policy,
        manualAccountId: explicit ?? runtime.getAccountsSnapshot().codex.activeAccountId,
        candidates: accountPoolCandidates(runtime.getAccountsSnapshot()).filter(
          (candidate) => candidate.provider === 'codex'
        )
      }
    }
  })
  return entry.host
}
export function peekRuntimeCodexEngineHost(runtime: object): CodexEngineHost | null {
  return hosts.get(runtime)?.host ?? null
}
export async function prepareRuntimeCodexNativeLaunch(
  runtime: Runtime,
  launch: NativeEngineLaunch & { accountId?: string; poolId?: string; initialAccountId?: string }
) {
  const entry = hosts.get(runtime)
  const host = getRuntimeCodexEngineHost(runtime)
  if (!entry || !host) {
    return null
  }
  if (entry.selections.size >= 64 || entry.selections.has(launch.launchId)) {
    throw new Error('Native routing launch capacity or ownership is unavailable.')
  }
  const context = {
    accountId: launch.accountId,
    poolId: launch.poolId,
    initialAccountId: launch.initialAccountId,
    initialPending: Boolean(launch.initialAssignment)
  }
  entry.selections.set(launch.launchId, context)
  try {
    const prepared = await host.prepareNativeLaunch({
      ...launch,
      onAccountSelected: (binding) => {
        context.initialPending = false
        launch.onAccountSelected?.(binding)
      }
    })
    if (!prepared) {
      entry.selections.delete(launch.launchId)
      return null
    }
    return {
      ...prepared,
      revoke: async () => {
        await prepared.revoke()
        entry.selections.delete(launch.launchId)
      },
      close: (verdict: 'exited' | 'unverifiable') => {
        prepared.close(verdict)
        if (verdict === 'exited') {
          entry.selections.delete(launch.launchId)
        }
      }
    }
  } catch (error) {
    entry.selections.delete(launch.launchId)
    throw error
  }
}
export async function stopRuntimeCodexEngineHost(runtime: object): Promise<void> {
  const entry = hosts.get(runtime)
  if (!entry) {
    return
  }
  await entry.host?.stop()
  hosts.delete(runtime)
}
export function beginRuntimeCodexEngineShutdown(runtime: object): Promise<void> | null {
  return hosts.get(runtime)?.host?.beginShutdown() ?? null
}
