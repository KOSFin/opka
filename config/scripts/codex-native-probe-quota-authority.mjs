/** Synthetic metadata only; the caller first isolates HOME before loading provider services. */
export async function createSyntheticCodexQuotaAuthority(home, report) {
  if (process.env.CODEX_HOME !== home || !process.env.HOME?.includes('native-policy-scratch-')) {
    throw new Error('Synthetic quota probe requires its private process environment')
  }
  const { RateLimitService } = await import('../../src/main/rate-limits/service.ts')
  const { accountPoolCandidates } =
    await import('../../src/main/runtime/account-pool-candidates.ts')
  const { createRuntimeCodexQuotaFailureRecorder } =
    await import('../../src/main/runtime/runtime-codex-quota-failure.ts')
  const settings = {
    activeCodexManagedAccountId: 'A',
    codexManagedAccounts: ['A', 'B'].map((id) => ({
      id,
      email: `${id}@example.test`,
      providerAccountId: id,
      managedHomePath: home,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }))
  }
  const service = new RateLimitService()
  service.setInactiveCodexAccountsResolver(() =>
    ['A', 'B'].map((id) => ({ id, resolveHome: () => ({ kind: 'skip' }) }))
  )
  const record = createRuntimeCodexQuotaFailureRecorder({
    getSettings: () => settings,
    readConnection: (id) => ({ providerAccountId: id }),
    rateLimits: service
  })
  return {
    record(event) {
      const accepted = record(event)
      report.quotaStamp = { ...event, accepted }
      return accepted
    },
    candidates: () =>
      accountPoolCandidates({
        claude: { accounts: [], activeAccountId: null },
        codex: { accounts: settings.codexManagedAccounts, activeAccountId: 'A' },
        rateLimits: service.getState()
      }),
    stop: () => service.stop()
  }
}
