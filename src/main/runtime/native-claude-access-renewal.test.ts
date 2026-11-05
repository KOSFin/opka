import { expect, it, vi } from 'vitest'
import type { ClaudeNativeAccessSnapshot } from '../claude-accounts/claude-native-access'
import { createNativeClaudeAccessRenewal } from './native-claude-access-renewal'

const NOW = 1_000_000
function access(account = 'a', expiresAt = NOW + 3600_000): ClaudeNativeAccessSnapshot {
  return {
    access: { accessToken: `fake-${account}-${expiresAt}`, expiresAt, scopes: ['user:inference'] },
    identity: {
      accountUuid: account,
      organizationUuid: 'org',
      emailAddress: `${account}@example.invalid`
    }
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture(assertAccessCurrent?: () => Promise<void>) {
  let accountId = 'a'
  let owner: string | null = 'owner'
  const refreshed = deferred<ClaudeNativeAccessSnapshot>()
  const refresh = vi.fn(async () => refreshed.promise)
  const publish = vi.fn(async (_access: ClaudeNativeAccessSnapshot, current: () => boolean) => {
    if (!current()) {
      throw new Error('stale')
    }
  })
  const renewal = createNativeClaudeAccessRenewal({
    initial: { accountId, access: access('a', NOW - 1) },
    refresh,
    publish,
    readAccountId: () => accountId,
    readOwnerIdentity: () => owner,
    assertAccessCurrent,
    now: () => NOW
  })
  return {
    refreshed,
    refresh,
    publish,
    renewal,
    account(value: string) {
      accountId = value
    },
    owner(value: string | null) {
      owner = value
    }
  }
}

it('shares one refresh before concurrent request admissions and retains no stale token version', async () => {
  const f = fixture()
  const first = f.renewal.prepareRequest(),
    second = f.renewal.prepareRequest()
  expect(f.refresh).toHaveBeenCalledOnce()
  const fresh = access()
  f.refreshed.resolve(fresh)
  await Promise.all([first, second])
  await f.renewal.prepareRequest()
  expect(f.refresh).toHaveBeenCalledOnce()
  expect(f.publish).toHaveBeenCalledOnce()
  expect(f.publish.mock.calls[0][0]).toBe(fresh)
})

it('does not invoke the native refresh authority for adequately fresh access', async () => {
  const f = fixture()
  f.renewal.selected({ accountId: 'a', access: access() })
  await f.renewal.prepareRequest()
  expect(f.refresh).not.toHaveBeenCalled()
})

it.each(['account', 'owner', 'owner-absent', 'same-account-version'] as const)(
  'refuses a late refresh after %s changes without publishing its stale result',
  async (change) => {
    const f = fixture()
    const pending = expect(f.renewal.prepareRequest()).rejects.toThrow('could not be confirmed')
    if (change === 'account') {
      f.account('b')
      f.renewal.selected({ accountId: 'b', access: access('b') })
    } else if (change === 'owner') {
      f.owner('new-owner')
    } else if (change === 'owner-absent') {
      f.owner(null)
    } else {
      f.renewal.selected({ accountId: 'a', access: access('a', NOW + 7200_000) })
    }
    f.refreshed.resolve(access())
    await pending
    expect(f.publish).not.toHaveBeenCalled()
  }
)

it('does not invalidate an in-flight refresh on identical selection notifications', async () => {
  const f = fixture()
  const pending = f.renewal.prepareRequest()
  f.renewal.selected({ accountId: 'a', access: access('a', NOW - 1) })
  f.refreshed.resolve(access())
  await pending
  expect(f.publish).toHaveBeenCalledOnce()
})

it.each(['identity', 'scope', 'expiry', 'nan', 'token'] as const)(
  'refuses refreshed access with invalid %s',
  async (invalid) => {
    const f = fixture(),
      value = access()
    const pending = expect(f.renewal.prepareRequest()).rejects.toThrow('could not be confirmed')
    if (invalid === 'identity') {
      value.identity.organizationUuid = 'another-org'
    }
    if (invalid === 'scope') {
      value.access.scopes = []
    }
    if (invalid === 'expiry') {
      value.access.expiresAt = NOW + 1000
    }
    if (invalid === 'nan') {
      value.access.expiresAt = Number.NaN
    }
    if (invalid === 'token') {
      value.access.accessToken = ''
    }
    f.refreshed.resolve(value)
    await pending
    expect(f.publish).not.toHaveBeenCalled()
  }
)

it('rechecks generation after asynchronous publication without approving a stale request', async () => {
  const f = fixture(),
    publishing = deferred<void>()
  f.publish.mockImplementationOnce(async () => publishing.promise)
  const pending = expect(f.renewal.prepareRequest()).rejects.toThrow('could not be confirmed')
  f.refreshed.resolve(access())
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce())
  f.account('b')
  f.renewal.selected({ accountId: 'b', access: access('b') })
  publishing.resolve()
  await pending
})

it('sanitizes refresh failures and abort reasons, allowing a later clean retry', async () => {
  const f = fixture()
  f.refresh.mockRejectedValueOnce(new Error('sensitive-error-value'))
  await expect(f.renewal.prepareRequest()).rejects.toThrow('could not be confirmed')
  const next = f.renewal.prepareRequest()
  f.refreshed.resolve(access())
  await next
  const abort = new AbortController()
  abort.abort(new Error('sensitive-abort-value'))
  await expect(f.renewal.prepareRequest(abort.signal)).rejects.toThrow('could not be confirmed')
})

it('revokes admissions on close and never publishes a refresh completed afterward', async () => {
  const f = fixture()
  const pending = expect(f.renewal.prepareRequest()).rejects.toThrow('could not be confirmed')
  f.renewal.close()
  f.refreshed.resolve(access())
  await pending
  await expect(f.renewal.prepareRequest()).rejects.toThrow('could not be confirmed')
  expect(f.publish).not.toHaveBeenCalled()
})

it('checks auth drift even for fresh access before permitting another model request', async () => {
  const guard = vi.fn(async () => {})
  const f = fixture(guard)
  f.renewal.selected({ accountId: 'a', access: access() })
  await f.renewal.prepareRequest()
  guard.mockRejectedValueOnce(new Error('sensitive-auth-override'))
  await expect(f.renewal.prepareRequest()).rejects.toThrow('could not be confirmed')
  expect(guard).toHaveBeenCalledTimes(2)
  expect(f.refresh).not.toHaveBeenCalled()
  expect(f.publish).not.toHaveBeenCalled()
})

it('rechecks owner authority after awaiting the current-auth guard', async () => {
  const checked = deferred<void>()
  const f = fixture(async () => checked.promise)
  f.renewal.selected({ accountId: 'a', access: access() })
  const pending = expect(f.renewal.prepareRequest()).rejects.toThrow('could not be confirmed')
  f.owner(null)
  checked.resolve()
  await pending
  expect(f.refresh).not.toHaveBeenCalled()
})

it('does not refresh or approve a request canceled while the auth guard was pending', async () => {
  const checked = deferred<void>(),
    abort = new AbortController()
  const f = fixture(async () => checked.promise)
  const pending = expect(f.renewal.prepareRequest(abort.signal)).rejects.toThrow(
    'could not be confirmed'
  )
  abort.abort(new Error('sensitive-abort-value'))
  checked.resolve()
  await pending
  expect(f.refresh).not.toHaveBeenCalled()
})
