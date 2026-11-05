import { nativeCodexUsesRemote } from '../shared/codex-global-options'
import { CODEX_GLOBAL_FLAGS_WITH_VALUES } from './codex-command-classification'

const CLAUDE_FLAGS_WITH_VALUES = new Set([
  '--model',
  '--agent',
  '--setting-sources',
  '--settings',
  '--mcp-config',
  '--add-dir',
  '--plugin-dir',
  '--fallback-model',
  '--permission-mode',
  '--effort',
  '--tools',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--system-prompt',
  '--append-system-prompt',
  '--system-prompt-file',
  '--append-system-prompt-file'
])
const MANAGEMENT_COMMANDS = new Set([
  'auth',
  'login',
  'logout',
  'completion',
  'completions',
  'doctor',
  'install',
  'update',
  'uninstall'
])
const CLAUDE_MANAGEMENT = new Set(['mcp', 'plugin', 'plugins', 'config', 'setup-token'])
const CODEX_MANAGEMENT = new Set(['mcp', 'features'])

function readNativeAgentInvocation(provider: 'claude' | 'codex', args: readonly string[]) {
  const boundary = args.indexOf('--')
  const options = boundary === -1 ? args : args.slice(0, boundary)
  const takesValue =
    provider === 'codex' ? CODEX_GLOBAL_FLAGS_WITH_VALUES : CLAUDE_FLAGS_WITH_VALUES
  let command: string | undefined
  let print = false
  for (let index = 0; index < options.length; index++) {
    const arg = options[index]
    if (provider === 'claude' && (arg === '--resume' || arg === '-r')) {
      if (options[index + 1] && !options[index + 1].startsWith('-')) {
        index++
      }
      continue
    }
    if (takesValue.has(arg)) {
      index++
      continue
    }
    if (['--help', '-h', '--version', '-V'].includes(arg)) {
      return { command: undefined, print: false, discovery: true }
    }
    if (
      provider === 'claude' &&
      (arg === '-p' || arg === '--print' || arg.startsWith('--print='))
    ) {
      print = true
    }
    if (!arg.startsWith('-') && command === undefined) {
      command = arg
    }
  }
  return { command, print, discovery: false }
}

export function nativeAgentAuthenticationCommand(
  provider: 'claude' | 'codex',
  args: readonly string[]
): boolean {
  const { command, print, discovery } = readNativeAgentInvocation(provider, args)
  return !print && !discovery && ['auth', 'login', 'logout', 'setup-token'].includes(command ?? '')
}

/** Login, discovery and help stay available even when the account broker is unavailable. */
export function nativeAgentNeedsAccount(
  provider: 'claude' | 'codex',
  args: readonly string[]
): boolean {
  if (provider === 'codex' && nativeCodexUsesRemote(args)) {
    return false
  }
  const { command, print, discovery } = readNativeAgentInvocation(provider, args)
  if (discovery) {
    return false
  }
  if (print || command === undefined) {
    return true
  }
  return (
    !MANAGEMENT_COMMANDS.has(command) &&
    !(provider === 'claude' ? CLAUDE_MANAGEMENT : CODEX_MANAGEMENT).has(command)
  )
}
