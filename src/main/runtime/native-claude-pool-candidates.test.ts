import { expect, it } from 'vitest'
import { readyNativeClaudePoolCandidates } from './native-claude-pool-candidates'
it('uses dedicated source auth instead of a missing legacy login while preserving exhausted quota', () => {
  const candidates = readyNativeClaudePoolCandidates(
    [
      {
        accountId: 'connected',
        quotaIdentity: 'same-real-quota',
        auth: 'unavailable',
        quota: 'exhausted',
        usedPercent: 100
      },
      {
        accountId: 'legacy-only',
        quotaIdentity: 'other',
        auth: 'ready',
        quota: 'unknown',
        usedPercent: null
      }
    ],
    new Set(['connected'])
  )
  expect(candidates).toEqual([
    {
      accountId: 'connected',
      quotaIdentity: 'same-real-quota',
      auth: 'ready',
      quota: 'exhausted',
      usedPercent: 100
    }
  ])
})
it('keeps attempted identities excluded even when their native refresh source is ready', () => {
  expect(
    readyNativeClaudePoolCandidates(
      [
        {
          accountId: 'tried',
          quotaIdentity: 'tried',
          auth: 'ready',
          quota: 'available',
          usedPercent: 0
        }
      ],
      new Set(['tried']),
      new Set(['tried'])
    )
  ).toEqual([])
})
