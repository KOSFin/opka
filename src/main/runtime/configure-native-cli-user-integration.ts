import { homedir } from 'node:os'
import { NativeCliUserIntegrationHost } from '../cli/native-cli-user-integration-host'
import { captureNativeAccountProfileOwnership } from './native-account-profile-ownership'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'

const services = new WeakMap<object, NativeCliUserIntegrationHost>()

/** Captures the boot owner only; no home/profile/launcher file is read or changed here. */
export function configureNativeCliUserIntegration(
  runtime: object,
  options: {
    store: { getProfileStorageDirectory(): string }
    dataRoot: string
    registerCleanup?: (cleanup: () => Promise<void>) => void
  }
): void {
  if (services.has(runtime)) {
    throw new Error('Native command setup is already configured for this runtime.')
  }
  const service = new NativeCliUserIntegrationHost({
    profileRoot: options.store.getProfileStorageDirectory(),
    dataRoot: options.dataRoot,
    assertExclusive: captureNativeAccountProfileOwnership(options.dataRoot),
    home: homedir,
    cliLauncher: () =>
      hasAppEnvironment() ? (getAppEnvironment().getCliLauncherPath?.() ?? null) : null,
    zdotdir: () => process.env.ZDOTDIR
  })
  services.set(runtime, service)
  options.registerCleanup?.(() => service.shutdown())
}
export function getRuntimeNativeCliUserIntegration(
  runtime: object
): NativeCliUserIntegrationHost | null {
  return services.get(runtime) ?? null
}
export function shutdownRuntimeNativeCliUserIntegration(runtime: object): Promise<void> {
  return services.get(runtime)?.shutdown() ?? Promise.resolve()
}
