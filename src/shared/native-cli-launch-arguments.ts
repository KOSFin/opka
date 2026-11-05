import { isAbsolute } from 'node:path'
import { nativeCodexUsesRemote } from './codex-global-options'
import type { NativeCliAccountLaunch } from './native-cli-account-launch'

/** Put host routing last among config overrides, without consuming native literal arguments. */
export function nativeCliLaunchArguments(
  provider: 'codex' | 'claude',
  args: string[],
  plan: Pick<NativeCliAccountLaunch, 'codexConfigOverrides' | 'claudePluginDirs'>
): string[] {
  if (plan.claudePluginDirs?.length) {
    if (
      provider !== 'claude' ||
      plan.codexConfigOverrides?.length ||
      plan.claudePluginDirs.length > 16 ||
      plan.claudePluginDirs.some((path) => !isAbsolute(path) || path.includes('\0'))
    ) {
      throw new Error('Native Claude modules require explicit host-owned absolute directories.')
    }
    const separator = args.indexOf('--')
    const insertion = separator === -1 ? args.length : separator
    return [
      ...args.slice(0, insertion),
      ...plan.claudePluginDirs.flatMap((path) => ['--plugin-dir', path]),
      ...args.slice(insertion)
    ]
  }
  if (!plan.codexConfigOverrides?.length) {
    return args
  }
  if (provider !== 'codex') {
    throw new Error('Codex transport configuration cannot be applied to Claude')
  }
  if (nativeCodexUsesRemote(args)) {
    throw new Error('Native remote Codex connections keep their execution host routing.')
  }
  const separator = args.indexOf('--')
  const insertion = separator === -1 ? args.length : separator
  return [
    ...(args.slice(0, insertion).includes('--no-daemon') ? [] : ['--no-daemon']),
    ...args.slice(0, insertion),
    ...plan.codexConfigOverrides.flatMap((value) => ['-c', value]),
    ...args.slice(insertion)
  ]
}
