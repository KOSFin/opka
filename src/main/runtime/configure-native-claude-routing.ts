import {
  configureRuntimeClaudeNativeSources,
  shutdownRuntimeClaudeNativeSources
} from './runtime-claude-native-sources'
import { captureNativeAccountProfileOwnership } from './native-account-profile-ownership'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'

type SourcesOptions = Parameters<typeof configureRuntimeClaudeNativeSources>[1]

export function configureNativeClaudeRouting(
  runtime: object,
  options: {
    store: { getProfileStorageDirectory(): string }
    dataRoot: string
    claudeAccounts: SourcesOptions['accounts'] & { cancelPendingLogin(): boolean }
    registerCleanup?: (cleanup: () => Promise<void>) => void
  }
): void {
  configureRuntimeClaudeNativeSources(runtime, {
    dataRoot: options.store.getProfileStorageDirectory(),
    accounts: options.claudeAccounts,
    assertExclusiveProfile: captureNativeAccountProfileOwnership(options.dataRoot),
    resolveHookLaunch: () => {
      const command = hasAppEnvironment() ? getAppEnvironment().getCliLauncherPath?.() : null
      return command ? { command, args: [] } : null
    }
  })
  options.registerCleanup?.(async () => {
    options.claudeAccounts.cancelPendingLogin()
    await shutdownRuntimeClaudeNativeSources(runtime)
  })
}
