import type { CodexTranscriptReadBudget } from '../../shared/codex-rollout-jsonl-cursor'
import { expect, it, vi } from 'vitest'
import type { AccountPoolPolicy } from '../../shared/account-pool-policy'
import {
  createCodexHostQuotaRetry,
  type CodexQuotaReplacementRequest
} from './codex-host-quota-retry'

function fixture(
  prepareReplacement?: (signal: AbortSignal, budget: CodexTranscriptReadBudget) => Promise<void>
) {
  const policy: AccountPoolPolicy = {
    id: 'pool',
    provider: 'codex',
    revision: 1,
    strategy: 'sequential',
    rotation: 'on-limit',
    applyToNewWork: true,
    unknownQuota: 'exclude',
    allowReserve: false,
    members: ['a', 'b', 'c'].map((accountId) => ({
      accountId,
      priority: 1,
      weight: 1,
      maxConcurrent: 1,
      state: 'enabled',
      role: 'primary'
    }))
  }
  const controller = new AbortController()
  const order: string[] = []
  let active = 1
  let next = 'b'
  const record = vi.fn(() => {
    order.push('stamp')
    return true
  })
  const replace = vi.fn((_request: CodexQuotaReplacementRequest) => {
    order.push('replace')
    return {
      accountId: next,
      quotaIdentity: next,
      policyRevision: policy.revision,
      assignmentOwnerKey: `owner-${next}`,
      poolId: policy.id
    }
  })
  const selected = vi.fn()
  const finish = vi.fn()
  const route = vi.fn(() => ({
    port: 1234,
    clientKey: 'synthetic-engine-key-1234567890123456',
    prefix: next
  }))
  const retry = createCodexHostQuotaRetry({
    prepareReplacement,
    initial: { accountId: 'a', quotaIdentity: 'a' },
    readPolicy: () => policy,
    activeRequests: () => active,
    recordFailure: record,
    replace,
    route,
    onAccountSelected: selected,
    signal: controller.signal,
    finish
  })
  if (!retry) {
    throw new Error('Missing test retry')
  }
  return {
    retry,
    policy,
    controller,
    record,
    replace,
    selected,
    finish,
    route,
    order,
    setActive: (value: number) => {
      active = value
    },
    setNext: (value: string) => {
      next = value
    }
  }
}
const quota = { kind: 'quota', code: 'usage_limit_reached' } as const
it('stamps before transactional replacement, keeps the original finish and signal, and excludes every quota identity', async () => {
  const f = fixture()
  const route = await f.retry(quota, { allowRetry: true })
  expect(f.order).toEqual(['stamp', 'replace'])
  expect(route).toMatchObject({
    accountId: 'b',
    quotaIdentity: 'b',
    finish: f.finish,
    signal: f.controller.signal
  })
  expect(f.selected).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: 'b', assignmentOwnerKey: 'owner-b' })
  )
  f.setNext('c')
  await route?.retryRejectedQuota?.(quota, { allowRetry: true })
  expect(f.record.mock.calls).toHaveLength(2)
  expect(f.replace.mock.calls[1][0]).toMatchObject({
    policyId: 'pool',
    expectedRevision: 1,
    excludedAccountIds: ['a', 'b'],
    excludedQuotaIdentities: ['a', 'b']
  })
  expect(f.finish).not.toHaveBeenCalled()
})
it.each(['concurrent', 'cancelled', 'attempt-cap', 'manual', 'off', 'stamp-failed'] as const)(
  'stamps but does not replace an unsafe request: %s',
  async (reason) => {
    const f = fixture()
    if (reason === 'concurrent') {
      f.setActive(2)
    }
    if (reason === 'cancelled') {
      f.controller.abort()
    }
    if (reason === 'manual') {
      f.policy.strategy = 'manual'
    }
    if (reason === 'off') {
      f.policy.rotation = 'off'
    }
    if (reason === 'stamp-failed') {
      f.record.mockReturnValue(false)
    }
    expect(await f.retry(quota, { allowRetry: reason !== 'attempt-cap' })).toBeNull()
    expect(f.record).toHaveBeenCalledOnce()
    expect(f.replace).not.toHaveBeenCalled()
  }
)
it('does not create pooled retry for a manual account without a verified quota identity', async () => {
  const f = fixture()
  expect(
    createCodexHostQuotaRetry({
      initial: { accountId: 'manual', quotaIdentity: null },
      readPolicy: () => f.policy,
      activeRequests: () => 1,
      recordFailure: f.record,
      replace: f.replace,
      route: f.route,
      signal: f.controller.signal,
      finish: f.finish
    })
  ).toBeUndefined()
})

it('does not attribute PTY usage to a replacement whose ready route fails', async () => {
  const f = fixture()
  f.route.mockImplementation(() => {
    throw new Error('Engine no longer adopted')
  })
  await expect(f.retry(quota, { allowRetry: true })).rejects.toThrow('Engine no longer adopted')
  expect(f.record).toHaveBeenCalledOnce()
  expect(f.replace).toHaveBeenCalledOnce()
  expect(f.selected).not.toHaveBeenCalled()
  expect(f.finish).not.toHaveBeenCalled()
})

it('prepares once with one shared budget after stamping, then checks fresh policy', async () => {
  let resume = () => {}
  const ready = new Promise<void>((resolve) => {
    resume = resolve
  })
  const prepare = vi.fn(async (_signal: AbortSignal, budget: CodexTranscriptReadBudget) => {
    budget.remainingBytes -= 1024
    await ready
  })
  const f = fixture(prepare)
  const pending = f.retry(quota, { allowRetry: true })
  await Promise.resolve()
  expect(f.record).toHaveBeenCalledOnce()
  expect(f.replace).not.toHaveBeenCalled()
  f.policy.revision = 2
  resume()
  const next = await pending
  expect(f.replace.mock.calls[0][0].expectedRevision).toBe(2)
  expect(f.replace.mock.calls[0][0].evidenceBudget).toBe(prepare.mock.calls[0][1])
  f.setNext('c')
  await next?.retryRejectedQuota?.(quota, { allowRetry: true })
  expect(prepare).toHaveBeenCalledOnce()
  expect(f.record).toHaveBeenCalledTimes(2)
  expect(f.replace.mock.calls[1][0].evidenceBudget).toBe(f.replace.mock.calls[0][0].evidenceBudget)
})
it('stamps but does not replace after cancellation while awaiting evidence', async () => {
  const request = new AbortController()
  const prepare = vi.fn(
    (signal: AbortSignal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      )
  )
  const f = fixture(prepare)
  const pending = f.retry(quota, { allowRetry: true, signal: request.signal })
  request.abort()
  expect(await pending).toBeNull()
  expect(f.record).toHaveBeenCalledOnce()
  expect(f.replace).not.toHaveBeenCalled()
})
