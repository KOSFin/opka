import { createNativeClaudeLiveRouting } from './native-claude-live-routing'
import { createNativeClaudeGatewayLiveRouting } from './native-claude-gateway-live-routing'
import type { createNativeClaudeRoutingSession } from './native-claude-routing-session'
import { installClaudeNativeCoverageModule } from '../claude-accounts/claude-native-coverage-install'
import {
  installClaudeNativePoolHooks,
  type createClaudeNativePoolHookSettings
} from '../claude-accounts/claude-native-pool-hooks'

export type NativeClaudeLaunchSession = Pick<
  ReturnType<typeof createNativeClaudeRoutingSession>,
  'assignment' | 'usesAccount' | 'applyIdlePolicy' | 'dispose'
>

/** Managed stdio uses one gateway controller; terminal launches retain the direct controller. */
export async function createNativeClaudeLaunchLiveMode(
  options: Parameters<typeof createNativeClaudeLiveRouting>[0] & {
    home: string
    gateway: boolean
    hookLaunch: { command: string; args: string[] }
    hooks: ReturnType<typeof createClaudeNativePoolHookSettings>
  }
) {
  const moduleDirectory = installClaudeNativeCoverageModule({
    home: options.home,
    launchId: options.launchId,
    launch: options.hookLaunch,
    assertExclusive: options.assertExclusive
  })
  if (options.gateway) {
    return { ...(await createNativeClaudeGatewayLiveRouting(options)), moduleDirectory }
  }
  installClaudeNativePoolHooks({
    home: options.home,
    settings: options.hooks,
    assertExclusive: options.assertExclusive
  })
  return { ...(await createNativeClaudeLiveRouting(options)), moduleDirectory, baseUrl: undefined }
}
