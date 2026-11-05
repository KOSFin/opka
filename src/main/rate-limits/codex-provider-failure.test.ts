import { afterEach, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchCodexRateLimits } from './codex-fetcher'
import { createEmptyRateLimitState } from '../../shared/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { accountPoolCandidates } from '../runtime/account-pool-candidates'
import type { AccountsSnapshot } from '../runtime/runtime-account-controller'
import type {
  CodexProviderFailureEvent,
  CodexProviderFailureAccount
} from './codex-provider-failure'
vi.mock('./grok-auth', () => ({ readGrokAuthSession: () => ({ status: 'missing' }) }))
vi.mock('./codex-fetcher', () => ({
  fetchCodexRateLimits: vi.fn(),
  consumeCodexRateLimitResetCredit: vi.fn()
}))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})
class Service extends RateLimitService {
  override getState() {
    return createEmptyRateLimitState({
      ...this.state,
      codexTarget: this.codexFetchTarget,
      inactiveCodexAccounts: this.buildInactiveArray(
        this.inactiveCodexCache,
        this.inactiveCodexFetching
      )
    })
  }
  seed(accountId: string, sample: ProviderRateLimits, active = false) {
    if (active) {
      this.state.codex = sample
    } else {
      this.inactiveCodexCache.set(accountId, sample)
    }
  }
  generations() {
    return [this.codexFetchGeneration, this.inactiveCodexAccountsGeneration]
  }
  applyPoll(id: string, fresh: ProviderRateLimits) {
    this.inactiveCodexCache.set(
      id,
      this.applyStalePolicy(fresh, this.inactiveCodexCache.get(id) ?? null)
    )
  }
  removePreview(id: string) {
    this.inactiveCodexCache.delete(id)
  }
  prune() {
    this.pruneInactiveCodexState()
  }
}
function proof(selected = false): CodexProviderFailureAccount {
  return { quotaIdentity: 'quota-a', authProvenance: 'profile:a', identityVerified: true, selected }
}
function event(): CodexProviderFailureEvent {
  return {
    accountId: 'a',
    quotaIdentity: 'quota-a',
    authProvenance: 'profile:a',
    code: 'usage_limit_reached',
    observedAt: Date.now()
  }
}
function sample(accountId: string, time = Date.now()): ProviderRateLimits {
  return {
    provider: 'codex',
    session: { usedPercent: 15, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    status: 'ok',
    error: null,
    updatedAt: time,
    usageMetadata: { authProvenance: `profile:${accountId}` }
  }
}
function source(service: Service): AccountsSnapshot {
  return {
    claude: { accounts: [], activeAccountId: null },
    codex: {
      accounts: ['a', 'b', 'alias'].map((id) => ({
        id,
        email: `${id}@example.test`,
        providerAccountId: id === 'b' ? 'quota-b' : 'quota-a',
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      })),
      activeAccountId: 'b'
    },
    rateLimits: service.getState()
  }
}
function inactive(service: Service) {
  service.setInactiveCodexAccountsResolver(() => [
    { id: 'a', resolveHome: () => ({ kind: 'skip' }) },
    { id: 'alias', resolveHome: () => ({ kind: 'skip' }) }
  ])
}

it('records verified first quota evidence in existing selected state without a percent/window', () => {
  const service = new Service(),
    notify = vi.fn()
  service.onStateChange(notify)
  expect(service.ingestCodexProviderFailure(event(), () => proof(true))).toBe(true)
  expect(service.getState().codex).toMatchObject({
    provider: 'codex',
    status: 'unavailable',
    updatedAt: 0,
    session: null,
    weekly: null,
    usageMetadata: {
      authProvenance: 'profile:a',
      confirmedProviderFailure: { quotaIdentity: 'quota-a', code: 'usage_limit_reached' }
    }
  })
  expect(service.generations()).toEqual([1, 1])
  expect(notify).toHaveBeenCalledTimes(1)
})
it('updates the actual routed inactive account and its quota aliases without changing native default usage', () => {
  const service = new Service()
  inactive(service)
  const active = sample('b')
  service.seed('b', active, true)
  expect(service.ingestCodexProviderFailure(event(), () => proof())).toBe(true)
  expect(service.getState().codex).toEqual(active)
  expect(
    accountPoolCandidates(source(service)).map((entry) => [
      entry.accountId,
      entry.quota,
      entry.usedPercent
    ])
  ).toEqual([
    ['a', 'exhausted', null],
    ['b', 'available', 15],
    ['alias', 'exhausted', null]
  ])
})
it('preserves previous measured percentages and their original timestamp', () => {
  const service = new Service()
  inactive(service)
  const previous = sample('a', Date.now() - 5000)
  service.seed('a', previous)
  expect(service.ingestCodexProviderFailure(event(), () => proof())).toBe(true)
  const recorded = service.getState().inactiveCodexAccounts[0]?.rateLimits
  expect(recorded).toMatchObject({ updatedAt: previous.updatedAt, session: previous.session })
  expect(recorded?.session?.usedPercent).toBe(15)
})
it('keeps unknown reset blocked until fresh authoritative success, including a same-quota alias', () => {
  vi.useFakeTimers()
  const service = new Service()
  inactive(service)
  service.ingestCodexProviderFailure(event(), () => proof())
  vi.setSystemTime(Date.now() + 24 * 60 * 60_000)
  expect(accountPoolCandidates(source(service))[0].quota).toBe('exhausted')
  service.seed('alias', sample('alias'))
  expect(accountPoolCandidates(source(service)).map((entry) => entry.quota)).toEqual([
    'unknown',
    'unknown',
    'available'
  ])
})
it('does not apply an old principal/provenance after account auth identity changes', () => {
  const service = new Service()
  inactive(service)
  const before = service.generations()
  expect(
    service.ingestCodexProviderFailure(event(), () => ({
      ...proof(),
      quotaIdentity: 'new-principal'
    }))
  ).toBe(false)
  expect(
    service.ingestCodexProviderFailure({ ...event(), authProvenance: 'profile:b' }, () => proof())
  ).toBe(false)
  expect(service.ingestCodexProviderFailure(event(), () => null)).toBe(false)
  expect(service.getState().inactiveCodexAccounts).toEqual([])
  expect(service.generations()).toEqual(before)
})
it('rejects implausible observation times and never silently adds unregistered accounts', () => {
  const service = new Service()
  for (const observedAt of [Number.NaN, Infinity, 0, Date.now() - 30_001, Date.now() + 100_001]) {
    expect(service.ingestCodexProviderFailure({ ...event(), observedAt }, () => proof(true))).toBe(
      false
    )
  }
  expect(service.ingestCodexProviderFailure(event(), () => proof())).toBe(false)
  expect(service.getState().inactiveCodexAccounts).toEqual([])
})
it('ignores reset/identity-invalid stamps in candidate projections', () => {
  const service = new Service()
  inactive(service)
  service.ingestCodexProviderFailure({ ...event(), resetsAt: Date.now() + 1000 }, () => proof())
  const snapshot = source(service)
  snapshot.codex.accounts[0].providerAccountId = 'new-principal'
  expect(accountPoolCandidates(snapshot).some((entry) => entry.quota === 'exhausted')).toBe(false)
  vi.useFakeTimers()
  vi.setSystemTime(Date.now() + 2000)
  expect(accountPoolCandidates(source(service))[0].quota).toBe('unknown')
})
it('fences a successful native poll started before the provider quota rejection', async () => {
  const service = new Service()
  service.setCodexHomePathResolver(() => ({
    kind: 'ready',
    codexHomePath: '/synthetic/not-read',
    authProvenance: 'profile:a'
  }))
  let finish: (value: ProviderRateLimits) => void = () => {}
  const pending = new Promise<ProviderRateLimits>((resolve) => {
    finish = resolve
  })
  const started = vi.fn()
  vi.mocked(fetchCodexRateLimits).mockImplementation(async () => {
    started()
    return pending
  })
  const refresh = service.refreshCodexForTarget({ runtime: 'host' })
  await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1))
  expect(service.ingestCodexProviderFailure(event(), () => proof(true))).toBe(true)
  finish(sample('a'))
  await refresh
  expect(service.getState().codex?.usageMetadata?.confirmedProviderFailure?.code).toBe(
    'usage_limit_reached'
  )
})

it('retains a proof-backed no-window stamp through unavailable polling and native selection pruning', () => {
  const service = new Service()
  service.ingestCodexProviderFailure(event(), () => proof(true))
  service.prune()
  expect(service.getState().inactiveCodexAccounts).toHaveLength(1)
  service.applyPoll('a', {
    ...sample('a'),
    session: null,
    status: 'unavailable',
    updatedAt: Date.now() + 10
  })
  expect(
    service.getState().inactiveCodexAccounts[0]?.rateLimits?.usageMetadata?.confirmedProviderFailure
      ?.code
  ).toBe('usage_limit_reached')
})
it('clears matching alias stamps durably after a fresh verified successful poll', () => {
  vi.useFakeTimers()
  const service = new Service()
  inactive(service)
  service.ingestCodexProviderFailure(event(), (id) => ({
    quotaIdentity: 'quota-a',
    authProvenance: `profile:${id}`,
    identityVerified: true,
    selected: false
  }))
  vi.setSystemTime(Date.now() + 1000)
  service.applyPoll('alias', sample('alias'))
  expect(
    service.getState().inactiveCodexAccounts.find((entry) => entry.accountId === 'a')?.rateLimits
      ?.usageMetadata?.confirmedProviderFailure
  ).toBeUndefined()
  service.removePreview('alias')
  expect(accountPoolCandidates(source(service))[0].quota).toBe('unknown')
})
