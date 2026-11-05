import { expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { OAuthUsageError } from '../rate-limits/claude-oauth-usage-error'
import { createNativeClaudeQuotaConfirmation } from './native-claude-quota-confirmation'
function fixture() {
  let now = 100_000,
    safe = true
  const current = {
    accountId: 'A',
    sessionId: 'native-root',
    owner: 'actual-owner',
    access: {
      identity: {
        accountUuid: 'account-A',
        organizationUuid: 'org-A',
        emailAddress: 'a@example.invalid'
      },
      access: {
        accessToken: 'synthetic-source-A',
        expiresAt: 1_000_000,
        scopes: ['user:inference']
      }
    }
  }
  const usage: ProviderRateLimits = {
    provider: 'claude',
    session: { usedPercent: 100, windowMinutes: 300, resetsAt: 200_000, resetDescription: null },
    weekly: null,
    updatedAt: now,
    status: 'ok',
    error: null
  }
  const fetchUsage = vi.fn(async () => usage),
    refresh = vi.fn(async () => current.access)
  const assertAccountOwned = vi.fn()
  const confirmation = createNativeClaudeQuotaConfirmation({
    readCurrent: () => current,
    refresh,
    assertAccountOwned,
    fetchUsage,
    now: () => now
  })
  const failure = { accountId: 'A', sessionId: 'native-root', promptId: 'actual-failure' }
  return {
    current,
    usage,
    fetchUsage,
    refresh,
    assertAccountOwned,
    confirmation,
    failure,
    confirm: () => confirmation.confirm(failure, () => safe),
    advance: (ms: number) => {
      now += ms
    },
    unsafe: () => {
      safe = false
    }
  }
}
it('confirms only a fresh subscription window and deduplicates its exact owned failure', async () => {
  const f = fixture()
  expect(await f.confirm()).toBe(true)
  expect(await f.confirm()).toBe(true)
  expect(f.fetchUsage).toHaveBeenCalledOnce()
  expect(f.fetchUsage).toHaveBeenCalledWith('synthetic-source-A', expect.any(AbortSignal))
  f.current.owner = 'replacement-owner'
  expect(await f.confirm()).toBe(true)
  expect(f.fetchUsage).toHaveBeenCalledTimes(2)
})
it('never interprets unknown, stale, reset or service-error usage as model quota', async () => {
  for (const change of [
    'available',
    'unknown',
    'stale',
    'future',
    'reset',
    'error',
    'provider'
  ] as const) {
    const f = fixture()
    if (change === 'available' && f.usage.session) {
      f.usage.session.usedPercent = 99
    }
    if (change === 'unknown') {
      f.usage.session = null
    }
    if (change === 'stale') {
      f.usage.updatedAt = 99_999
    }
    if (change === 'future') {
      f.usage.updatedAt = 102_000
    }
    if (change === 'reset' && f.usage.session) {
      f.usage.session.resetsAt = 99_000
    }
    if (change === 'error') {
      f.usage.status = 'error'
    }
    if (change === 'provider') {
      f.usage.provider = 'codex'
    }
    expect(await f.confirm(), change).toBe(false)
  }
})
it('requires an account-owned source and refuses changed identity without querying usage', async () => {
  const f = fixture()
  f.refresh.mockResolvedValue({
    ...f.current.access,
    identity: { ...f.current.access.identity, accountUuid: 'other' }
  })
  expect(await f.confirm()).toBe(false)
  expect(f.fetchUsage).not.toHaveBeenCalled()
  const g = fixture()
  g.assertAccountOwned.mockImplementation(() => {
    throw new Error('synthetic unknown ownership')
  })
  expect(await g.confirm()).toBe(false)
  expect(g.refresh).not.toHaveBeenCalled()
})
it('fences source, owner, token and canonical failure changes after asynchronous usage', async () => {
  for (const changed of ['owner', 'account', 'root', 'access', 'boundary', 'close'] as const) {
    const f = fixture()
    f.fetchUsage.mockImplementation(async () => {
      if (changed === 'owner') {
        f.current.owner = 'new-owner'
      }
      if (changed === 'account') {
        f.current.accountId = 'B'
      }
      if (changed === 'root') {
        f.current.sessionId = 'new-root'
      }
      if (changed === 'access') {
        f.current.access.access.accessToken = 'new-native-access'
      }
      if (changed === 'boundary') {
        f.unsafe()
      }
      if (changed === 'close') {
        f.confirmation.close()
      }
      return f.usage
    })
    expect(await f.confirm(), changed).toBe(false)
  }
})
it('retains bounded per-account Retry-After and never treats usage API429 as quota', async () => {
  const f = fixture()
  f.fetchUsage.mockRejectedValue(new OAuthUsageError('synthetic rate limit', 429, true, 30_000))
  expect(await f.confirm()).toBe(false)
  f.advance(20_000)
  expect(await f.confirm()).toBe(false)
  expect(f.fetchUsage).toHaveBeenCalledOnce()
  f.advance(11_000)
  expect(await f.confirm()).toBe(false)
  expect(f.fetchUsage).toHaveBeenCalledTimes(2)
})
it('coalesces simultaneous calls and refuses unrelated pending failures', async () => {
  const f = fixture()
  let release: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  f.fetchUsage.mockImplementation(async () => {
    await wait
    return f.usage
  })
  const first = f.confirm(),
    second = f.confirm()
  expect(await f.confirmation.confirm({ ...f.failure, promptId: 'another' }, () => true)).toBe(
    false
  )
  release()
  expect(await first).toBe(true)
  expect(await second).toBe(true)
  expect(f.refresh).toHaveBeenCalledOnce()
  expect(f.fetchUsage).toHaveBeenCalledOnce()
})
