export const CODEX_GLOBAL_FLAGS_WITH_VALUES = new Set([
  '--config',
  '-c',
  '--enable',
  '--disable',
  '--remote',
  '--remote-auth-token-env',
  '--image',
  '-i',
  '--model',
  '-m',
  '--local-provider',
  '--profile',
  '-p',
  '--sandbox',
  '-s',
  '--cd',
  '-C',
  '--add-dir',
  '--ask-for-approval',
  '-a'
])

export function nativeCodexUsesRemote(args: readonly string[]): boolean {
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    const arg = args[index]
    if (arg === '--remote' || arg.startsWith('--remote=')) {
      return true
    }
    if (CODEX_GLOBAL_FLAGS_WITH_VALUES.has(arg)) {
      index++
    }
  }
  return false
}

export function nativeCodexPositionalCommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    const value = args[index]
    if (CODEX_GLOBAL_FLAGS_WITH_VALUES.has(value)) {
      index++
    } else if (!value.startsWith('-')) {
      return value
    }
  }
  return undefined
}
