import type { NativeCliAccountLaunch } from '../../shared/native-cli-account-launch'
import { isNativeClaudeRoutingLaunch } from './native-claude-routing-ownership'

const pending = new WeakMap<object, Set<string>>()

/** A duplicate request must never release or dispose another live CLI's preparation. */
export async function withNativeClaudeLaunchPreparation(
  runtime: object,
  launchId: string,
  prepare: () => Promise<NativeCliAccountLaunch | null>
): Promise<NativeCliAccountLaunch | null> {
  let launches = pending.get(runtime)
  if (!launches) {
    launches = new Set()
    pending.set(runtime, launches)
  }
  if (
    launches.size >= 128 ||
    launches.has(launchId) ||
    isNativeClaudeRoutingLaunch(runtime, launchId)
  ) {
    throw new Error('This native Claude launch is already active or unavailable.')
  }
  launches.add(launchId)
  try {
    return await prepare()
  } finally {
    launches.delete(launchId)
  }
}
