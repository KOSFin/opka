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
    'Connect a pool account to native routing in Accounts before starting this CLI.',
  config_conflict:
    'Native preferences changed in both the source and Orca HOME. Review model, effort, and service tier on this host before retrying.',
  routing_auth_conflict:
    'The native routing HOME contains another login. Preserve and review it on this host before retrying; no login was replaced.',
  routing_auth_pending:
    'Native routing credential publication is pending or unverifiable. Review the preserved files on this host.',
  home_preparation_pending:
    'A previous native HOME preparation stopped mid-write. Review the preserved files on this host before retrying.',
  trust_proof_missing:
    'Project trust cannot be added without verified source trust and path identity. Review the project on this host.'
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

export function nativeCliControlMessage(code: string): string | null {
  for (const [reason, message] of Object.entries(MESSAGES)) {
    if (code === `native_cli_${reason}`) {
      return message
    }
  }
  return null
}
