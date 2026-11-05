import {
  NATIVE_CLI_ACCOUNT_PIN_ENV,
  NATIVE_CLI_INITIAL_ASSIGNMENT_ENV
} from './native-cli-account-launch'

export function nativeCliAccountContext(
  provider: 'claude' | 'codex',
  env: Record<string, string | undefined>
): { accountId?: string; initialAssignmentOwnerKey?: string } {
  const pin = env[NATIVE_CLI_ACCOUNT_PIN_ENV],
    accountId = pin?.startsWith(`${provider}:`) ? pin.slice(provider.length + 1) : undefined,
    initial = env[NATIVE_CLI_INITIAL_ASSIGNMENT_ENV]
  if (
    (accountId !== undefined && (!accountId || accountId.length > 256)) ||
    (initial !== undefined && (!initial || initial.length > 256))
  ) {
    throw new Error('Native account launch context is invalid.')
  }
  return {
    ...(accountId ? { accountId } : {}),
    ...(initial ? { initialAssignmentOwnerKey: initial } : {})
  }
}
