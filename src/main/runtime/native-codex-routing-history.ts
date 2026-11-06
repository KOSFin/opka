import { prepareNativeCodexStatusHooks } from '../codex-routing/native-codex-status-hooks'
import { isAgentStatusHooksEnabledForAgent } from '../agent-hooks/managed-agent-hook-controls'
import { prepareCodexNativeHome } from '../codex-routing/codex-native-home'
import { readManagedNativeTrustKeys } from '../codex-routing/codex-native-home-managed-config'
import { prepareNativeCodexGatewayAuth } from '../codex-routing/native-codex-gateway-credential'
import type { NativeCodexRoutingContext } from './read-native-codex-routing-context'
import { readIndexedCodexRolloutPath } from '../codex/codex-indexed-rollout-path'
import type { OrcaRuntimeService } from './orca-runtime'
import type { NativeCliAccountLaunchRequest } from '../../shared/native-cli-account-launch'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { claimNativeCodexHistoryHome } from './native-codex-routing-ownership'
import { claimRuntimeCodexHistoryHome } from './runtime-codex-engine-host'

/** Native auth/state stay owned while a dialog is adopted once and account grants rotate elsewhere. */
export async function prepareNativeCodexRoutingHistory(
  runtime: Pick<OrcaRuntimeService, 'requireStore' | 'getCommitMessageAgentEnvironmentResolvers'>,
  params: NativeCliAccountLaunchRequest,
  localGatewayKey: string,
  resolved: NativeCodexRoutingContext
) {
  const { context, nativeVersion, executable, sourceHome, selectedSourceHome } = resolved
  const previous = runtime.requireStore().getSettings().codexManagedAccounts ?? []
  const backing = previous.find(
    (account) =>
      normalizeRuntimePathForComparison(account.managedHomePath) ===
      normalizeRuntimePathForComparison(sourceHome)
  )
  const releaseSource = claim(runtime, sourceHome, backing?.id ?? null)
  let releaseOwned: ReturnType<typeof claim> | undefined
  try {
    const sourcePath = params.codexResumeSessionId
      ? readIndexedCodexRolloutPath(selectedSourceHome, params.codexResumeSessionId)
      : null
    const prepared = await prepareCodexNativeHome({
      ...context,
      sourceHome,
      prepareManagedConfig: async (home) => {
        const keys = readManagedNativeTrustKeys(home)
        prepareNativeCodexGatewayAuth(home, localGatewayKey, context.assertExclusive)
        await prepareNativeCodexStatusHooks({
          home,
          executable,
          assertExclusive: context.assertExclusive,
          isEnabled: () =>
            isAgentStatusHooksEnabledForAgent(runtime.requireStore().getSettings(), 'codex')
        })
        for (const key of readManagedNativeTrustKeys(home)) {
          keys.add(key)
        }
        return keys
      },
      context: {
        nativeVersion,
        profile: params.codexProfile,
        providerOverride: params.codexModelProvider,
        cwd: params.codexWorkingDirectory,
        catalogOverride: params.codexModelCatalogPath
      },
      ...(sourcePath
        ? { adopt: { sourceHome: selectedSourceHome, transcriptPath: sourcePath } }
        : {})
    })
    releaseOwned = claim(runtime, prepared.home, null)
    return {
      home: prepared.home,
      release: (verdict: 'exited' | 'unverifiable' = 'exited') => {
        try {
          releaseOwned?.(verdict)
        } finally {
          releaseSource(verdict)
        }
      }
    }
  } catch (error) {
    try {
      releaseOwned?.('exited')
    } finally {
      releaseSource('exited')
    }
    throw error
  }
}
function claim(runtime: object, home: string, accountId: string | null) {
  const release = claimNativeCodexHistoryHome(home, accountId ?? undefined)
  try {
    const durable = claimRuntimeCodexHistoryHome(runtime, { home, accountId })
    return (verdict: 'exited' | 'unverifiable' = 'exited') => {
      try {
        durable(verdict)
      } finally {
        release()
      }
    }
  } catch (error) {
    release()
    throw error
  }
}
