export function usageAccountProvenance(runtimeKey: string, accountId: string | null): string {
  if (accountId === null) {
    return runtimeKey === 'host' ? 'system' : `${runtimeKey}:system`
  }
  return runtimeKey === 'host' ? `profile:${accountId}` : `profile:${accountId}:${runtimeKey}`
}

export function usageMatchesAccount(
  usage: { usageMetadata?: { authProvenance?: string } } | null | undefined,
  runtimeKey: string,
  accountId: string | null
): boolean {
  return usage?.usageMetadata?.authProvenance === usageAccountProvenance(runtimeKey, accountId)
}

export function inactiveUsageMatchesAccount(
  usage: { usageMetadata?: { authProvenance?: string } } | null | undefined,
  runtimeKey: string,
  accountId: string
): boolean {
  // Legacy inactive samples are attributed by their outer accountId; explicit proof must agree.
  return (
    usage != null &&
    (usage.usageMetadata?.authProvenance === undefined ||
      usageMatchesAccount(usage, runtimeKey, accountId))
  )
}
