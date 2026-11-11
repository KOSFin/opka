import { expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { AccountPoolCandidate } from '../../shared/account-pool-policy'
import { mapCodexRateLimitWindow } from '../rate-limits/codex-rate-limit-window-mapper'
import { rankQuotaEqualizeMembersWithReason } from './account-pool-quota-equalize'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import { ACCOUNT_POOL_METHODS } from './rpc/methods/account-pools'
import { eraseRpcMethods, isStreamingMethod } from './rpc/core'
import type { OrcaRuntimeService } from './orca-runtime'
import { AccountPoolViewSchema } from '../../shared/account-pool-view'

function member(id: string, percentage: number, reset: number | null) {
  const candidate: AccountPoolCandidate = {
    accountId: id,
    quotaIdentity: id,
    auth: 'ready',
    quota: 'available',
    usedPercent: percentage,
    quotaWindows: [
      {
        windowMinutes: 10080,
        verifiedDurationMinutes: 10080,
        usedPercent: percentage,
        resetsAt: reset
      }
    ]
  }
  return { candidate, active: 0, sequence: 0, weight: 1 }
}

it('preserves the winning independent weekly account and compared reason under input permutation', () => {
  const low = member('low', 5, Date.now() + 86_400_000)
  const high = member('high', 50, Date.now() + 4 * 86_400_000)
  for (const order of [
    [low, high],
    [high, low]
  ]) {
    const decision = rankQuotaEqualizeMembersWithReason([...order], 'high')
    expect(decision.ranked[0].candidate.accountId).toBe('low')
    expect(decision.reason).toContain('5%')
    expect(decision.reason).toContain('50%')
  }
})

it('accepts raw duration tolerance edges but never promotes positional fallback', () => {
  for (const rawDuration of [10079, 10081]) {
    const mapped = mapCodexRateLimitWindow(
      { usedPercent: 5, windowDurationMins: rawDuration },
      10080
    )
    expect(mapped?.verifiedDurationMinutes).toBe(10080)
  }
  for (const rawDuration of [undefined, '10080', 10082]) {
    const mapped = mapCodexRateLimitWindow(
      { usedPercent: 5, windowDurationMins: rawDuration },
      10080
    )
    expect(mapped?.verifiedDurationMinutes).toBeUndefined()
  }
  const unknown = member('unknown', 5, null)
  unknown.candidate.quotaWindows = [{ windowMinutes: 10080, usedPercent: 5, resetsAt: null }]
  unknown.active = 1
  const measured = member('measured', 50, null)
  const decision = rankQuotaEqualizeMembersWithReason([unknown, measured])
  expect(decision.ranked[0].candidate.accountId).toBe('measured')
  expect(decision.reason).toContain('unverified-duration-or-reset')
  expect(decision.reason).not.toMatch(/\d+%/)
})

it('keeps null reset comparable and rejects past or implausibly future reset metadata', () => {
  const known = member('known', 50, null)
  const low = member('low', 5, null)
  expect(rankQuotaEqualizeMembersWithReason([known, low]).ranked[0].candidate.accountId).toBe('low')
  for (const invalidReset of [Date.now() - 1000, Date.now() + 9 * 86_400_000]) {
    low.candidate.quotaWindows = [
      {
        windowMinutes: 10080,
        verifiedDurationMinutes: 10080,
        usedPercent: 5,
        resetsAt: invalidReset
      }
    ]
    low.active = 1
    const decision = rankQuotaEqualizeMembersWithReason([low, known])
    expect(decision.ranked[0].candidate.accountId).toBe('known')
    expect(decision.reason).not.toMatch(/\d+%/)
  }
})

it('migrates the old table and publishes the actual host decision through accountPool.list', async () => {
  const db = new OrchestrationDb(':memory:')
  try {
    db.db.exec('ALTER TABLE account_pool_assignments DROP COLUMN selection_reason')
    db.db.pragma('user_version = 43')
    db.migrate()
    db.migrate()
    const columns = db.db.prepare('PRAGMA table_info(account_pool_assignments)').all()
    expect(columns.filter((column) => column.name === 'selection_reason')).toHaveLength(1)

    const high = member('high', 50, Date.now() + 86_400_000)
    const low = member('low', 5, Date.now() + 4 * 86_400_000)
    const admission = {
      ownerKey: 'pty:quota-review:generation-1',
      policy: {
        id: 'review-pool',
        provider: 'codex' as const,
        revision: 1,
        strategy: 'quota-equalize' as const,
        applyToNewWork: true,
        rotation: 'after-turn' as const,
        unknownQuota: 'exclude' as const,
        allowReserve: false,
        members: [high, low].map((entry) => ({
          accountId: entry.candidate.accountId,
          priority: 1,
          weight: 1,
          state: 'enabled' as const,
          role: 'primary' as const
        }))
      },
      candidates: [high.candidate, low.candidate],
      preferredAccountId: 'high'
    }
    const first = db.acquireAccountPoolAssignment(admission)
    const repeated = db.acquireAccountPoolAssignment(admission)
    expect(repeated).toEqual(first)
    expect(first.accountId).toBe('low')
    expect(db.listAccountPoolAssignments()).toMatchObject([
      { accountId: 'low', selectionReason: expect.stringContaining('50%') }
    ])

    const list = eraseRpcMethods(ACCOUNT_POOL_METHODS).find(
      (method) => method.name === 'accountPool.list'
    )
    if (!list || isStreamingMethod(list)) {
      throw new Error('Missing accountPool.list handler')
    }
    const snapshot = {
      claude: { accounts: [], activeAccountId: null },
      codex: {
        accounts: [
          { id: 'high', email: 'high@example.test', lastAuthenticatedAt: 1 },
          { id: 'low', email: 'low@example.test', lastAuthenticatedAt: 1 }
        ],
        activeAccountId: 'high'
      },
      rateLimits: {
        codex: null,
        claude: null,
        inactiveCodexAccounts: [],
        inactiveClaudeAccounts: []
      }
    }
    const host = {
      getAccountsSnapshot: () => snapshot,
      getOrchestrationDb: () => db,
      requireStore: () => ({ getSettings: () => ({ accountPools: [admission.policy] }) })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list handler reads only the three stubbed runtime methods.
    const runtime = host as unknown as OrcaRuntimeService
    const response = AccountPoolViewSchema.parse(await list.handler(undefined, { runtime }))
    expect(response.assignments).toMatchObject([
      { accountId: 'low', selectionReason: expect.stringContaining('50%') }
    ])
    const evidencePath = process.env.ORCA_QUOTA_REVIEW_EVIDENCE_PATH
    if (evidencePath) {
      if (!isAbsolute(evidencePath)) {
        throw new Error('Review evidence path must be absolute')
      }
      writeFileSync(evidencePath, JSON.stringify(response, null, 2))
    }
    const legacy = {
      ...response,
      assignments: response.assignments.map(({ selectionReason: _reason, ...rest }) => rest)
    }
    expect(AccountPoolViewSchema.safeParse(legacy).success).toBe(true)
  } finally {
    db.close()
  }
})
