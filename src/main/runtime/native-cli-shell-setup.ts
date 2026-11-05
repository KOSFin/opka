import type { NativeCliUserIntegrationStatus } from '../cli/native-cli-user-integration-host'
import type { NativeCliShellSetup } from '../../shared/native-cli-shell-setup'
import { getRuntimeNativeCliUserIntegration } from './configure-native-cli-user-integration'

export function projectNativeCliShellSetup(
  status: NativeCliUserIntegrationStatus
): NativeCliShellSetup {
  return { supported: status.supported, state: status.state, missing: [...status.missing] }
}

/** Paired clients get setup state, never host paths or shell contents. */
export async function readRuntimeNativeCliShellSetup(
  runtime: object
): Promise<NativeCliShellSetup> {
  const service = getRuntimeNativeCliUserIntegration(runtime)
  if (!service) {
    return { supported: false, state: 'unsupported', missing: [] }
  }
  const status = await service.status()
  return projectNativeCliShellSetup(status)
}
