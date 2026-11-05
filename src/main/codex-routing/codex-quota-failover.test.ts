import { expect, it, vi } from 'vitest'
import type { AccountPoolPolicy } from '../../shared/account-pool-policy'
import {
  classifyCodexEngineFailure,
  createCodexQuotaFailoverAttempt,
  type CodexRetryExposure
} from './codex-quota-failover'
const exposure: CodexRetryExposure = {
  headersSent: false,
  bytesEmitted: 0,
  acceptedTool: false,
  partialStream: false,
  cancelled: false,
  otherRequestsActive: false
}
const policy: AccountPoolPolicy = {
  id: 'pool',
  provider: 'codex',
  revision: 3,
  strategy: 'balanced',
  applyToNewWork: true,
  rotation: 'on-limit',
  unknownQuota: 'exclude',
  allowReserve: false,
  members: ['a', 'b', 'c'].map((accountId) => ({
    accountId,
    priority: 1,
    weight: 1,
    state: 'enabled',
    role: 'primary'
  }))
}
function failure(status: number, error: unknown) {
  return classifyCodexEngineFailure({
    status,
    contentType: 'application/json',
    complete: true,
    body: Buffer.from(JSON.stringify({ error }))
  })
}
function fixture(maxAttempts = 3) {
  const record = vi.fn(() => true)
  const acquire = vi.fn(() => ({ accountId: 'b', quotaIdentity: 'qb' }))
  return {
    record,
    acquire,
    attempt: createCodexQuotaFailoverAttempt({
      initial: { accountId: 'a', quotaIdentity: 'qa' },
      maxAttempts,
      recordQuotaFailure: record,
      acquireReplacement: acquire
    })
  }
}
const quota = { kind: 'quota', code: 'usage_limit_reached' } as const

it('recognizes only exact complete quota JSON and returns no message/body data', () => {
  expect(failure(429, { type: 'usage_limit_reached', message: 'private-content' })).toEqual(quota)
  expect(failure(429, { type: 'rate_limit_error', code: 'usage_limit_reached' })).toEqual(quota)
  for (const status of [200, 401, 403, 500]) {
    expect(failure(status, { type: 'usage_limit_reached' })).toBeNull()
  }
  for (const error of [
    { code: 'rate_limit_exceeded' },
    { code: 'insufficient_quota' },
    { message: 'usage_limit_reached' },
    { type: 'usage_limit_reached', code: 'model_not_found' },
    { code: 'usage_limit_reached', type: 'authentication_error' }
  ]) {
    expect(failure(429, error)).toBeNull()
  }
  for (const input of [
    {
      contentType: 'text/event-stream',
      complete: true,
      body: Buffer.from('{"error":{"code":"usage_limit_reached"}}')
    },
    {
      contentType: 'application/json',
      complete: false,
      body: Buffer.from('{"error":{"code":"usage_limit_reached"}}')
    },
    { contentType: 'application/json', complete: true, body: Buffer.alloc(16385) },
    { contentType: 'text/html', complete: true, body: Buffer.from('usage_limit_reached') }
  ]) {
    expect(classifyCodexEngineFailure({ status: 429, ...input })).toBeNull()
  }
})
it('converts only plausible provider reset seconds, without inferring a window', () => {
  const now = Date.now()
  const result = classifyCodexEngineFailure(
    {
      status: 429,
      contentType: 'application/json',
      complete: true,
      body: Buffer.from(
        JSON.stringify({
          error: { code: 'usage_limit_reached', resets_at: Math.floor(now / 1000) + 60 }
        })
      )
    },
    now
  )
  expect(result).toEqual({ ...quota, resetsAt: (Math.floor(now / 1000) + 60) * 1000 })
  expect(failure(429, { code: 'usage_limit_reached', resets_at: 1 })).toEqual(quota)
})
it('classifies auth separately and never retries or stamps quota on sign-in errors', () => {
  const f = fixture()
  const auth = failure(401, { code: 'token_expired' })
  expect(auth).toEqual({ kind: 'authentication', code: 'token_expired' })
  expect(f.attempt.retry(auth, policy, exposure)).toEqual({ kind: 'reauth-required' })
  expect(f.record).not.toHaveBeenCalled()
  expect(f.acquire).not.toHaveBeenCalled()
})
it('stamps existing authority before asking the session transaction for a distinct replacement', () => {
  const f = fixture()
  expect(f.attempt.retry(quota, policy, exposure)).toEqual({
    kind: 'retry',
    account: { accountId: 'b', quotaIdentity: 'qb' }
  })
  expect(f.record).toHaveBeenCalledWith({
    accountId: 'a',
    quotaIdentity: 'qa',
    code: 'usage_limit_reached'
  })
  expect(f.record.mock.invocationCallOrder[0]).toBeLessThan(f.acquire.mock.invocationCallOrder[0])
  expect(f.acquire).toHaveBeenCalledWith({
    policyId: 'pool',
    expectedRevision: 3,
    excludedAccountIds: ['a'],
    excludedQuotaIdentities: ['qa']
  })
})
it.each(['headersSent', 'acceptedTool', 'partialStream', 'cancelled', 'otherRequestsActive'])(
  'never retries after %s or uncertain request acceptance',
  (field) => {
    const f = fixture()
    expect(f.attempt.retry(quota, policy, { ...exposure, [field]: true })).toEqual({
      kind: 'stop',
      reason: 'unsafe-request'
    })
    expect(f.acquire).not.toHaveBeenCalled()
  }
)
it('never retries after emitted bytes or an unconfirmed authority update', () => {
  const f = fixture()
  f.record.mockReturnValue(false)
  expect(f.attempt.retry(quota, policy, exposure)).toEqual({
    kind: 'stop',
    reason: 'authority-unconfirmed'
  })
  expect(f.acquire).not.toHaveBeenCalled()
  expect(fixture().attempt.retry(quota, policy, { ...exposure, bytesEmitted: 1 })).toEqual({
    kind: 'stop',
    reason: 'unsafe-request'
  })
})
it('honors manual, pause and rotation off without manufacturing another account', () => {
  for (const update of [
    { strategy: 'manual' as const },
    { applyToNewWork: false },
    { rotation: 'off' as const }
  ]) {
    const f = fixture()
    expect(f.attempt.retry(quota, { ...policy, ...update }, exposure)).toEqual({
      kind: 'stop',
      reason: 'policy-disabled'
    })
    expect(f.acquire).not.toHaveBeenCalled()
  }
})
it('bounds attempts, rejects a second profile of the same quota and becomes terminal', () => {
  const f = fixture(2)
  expect(f.attempt.retry(quota, policy, exposure).kind).toBe('retry')
  expect(f.attempt.retry(quota, policy, exposure)).toEqual({
    kind: 'stop',
    reason: 'attempt-limit'
  })
  expect(f.acquire).toHaveBeenCalledTimes(1)
  const alias = fixture()
  alias.acquire.mockReturnValue({ accountId: 'other-profile', quotaIdentity: 'qa' })
  expect(alias.attempt.retry(quota, policy, exposure)).toEqual({
    kind: 'stop',
    reason: 'invalid-replacement'
  })
  expect(alias.attempt.retry(quota, policy, exposure)).toEqual({
    kind: 'stop',
    reason: 'already-finished'
  })
  expect(() => fixture(17)).toThrow('between 1 and 16')
})
