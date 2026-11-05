const MESSAGES = {
  retention_full:
    'Native CLI retained-work limit reached. Review unfinished or unverifiable native sessions before starting more.',
  recovery_required:
    'Previous native account work requires recovery. Close or recover its sessions before starting another routed CLI.',
  capacity:
    'This host has reached its native CLI capacity. Finish an existing session before starting another.',
  unsupported:
    'This native CLI version or execution mode is not qualified for account routing. Check the host CLI setup in Accounts.',
  owner_changed: 'The native CLI owner changed. Start a new session on its execution host.',
  accounts_not_connected:
    'Connect a pool account to native routing in Accounts before starting this CLI.'
} as const

/** Only fixed public diagnostics may cross a credential-bearing control boundary. */
export class NativeCliControlError extends Error {
  readonly code: string
  constructor(readonly reason: keyof typeof MESSAGES) {
    super(MESSAGES[reason])
    this.name = 'NativeCliControlError'
    this.code = `native_cli_${reason}`
  }
}
export function nativeCliControlErrorReply(error: unknown) {
  if (!(error instanceof NativeCliControlError) || !Object.hasOwn(MESSAGES, error.reason)) {
    return null
  }
  return { code: `native_cli_${error.reason}`, message: MESSAGES[error.reason] }
}
