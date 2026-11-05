import { NativeCliShellSetupSchema, type NativeCliShellSetup } from './native-cli-shell-setup'

export type NativeCliShellSetupAction = 'install' | 'uninstall'
export function nativeCliShellSetupActionMethod(action: NativeCliShellSetupAction) {
  return action === 'install'
    ? 'accounts.installNativeCliIntegration'
    : 'accounts.uninstallNativeCliIntegration'
}
/** One explicit host operation; a lost reply never authorizes an automatic retry. */
export async function runNativeCliShellSetupAction(options: {
  action: NativeCliShellSetupAction
  request: (
    method: ReturnType<typeof nativeCliShellSetupActionMethod>,
    signal: AbortSignal
  ) => Promise<unknown>
  signal: AbortSignal
}): Promise<NativeCliShellSetup | null> {
  if (options.signal.aborted) {
    return null
  }
  try {
    const result = await options.request(
      nativeCliShellSetupActionMethod(options.action),
      options.signal
    )
    return options.signal.aborted ? null : NativeCliShellSetupSchema.parse(result)
  } catch {
    if (options.signal.aborted) {
      return null
    }
    throw new Error(
      'CLI setup could not be confirmed. Existing user changes are preserved; refresh its status before trying again.'
    )
  }
}

export type NativeCliShellSetupActionOwner = {
  active: boolean
  busy: boolean
  controller: AbortController | null
}
export function createNativeCliShellSetupActionOwner(): NativeCliShellSetupActionOwner {
  return { active: true, busy: false, controller: null }
}
