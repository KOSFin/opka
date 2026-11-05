import { expect, it } from 'vitest'
import { fixture, replacement, signal } from './native-claude-gateway-route-fixture'

it('retains accepted B occupancy after HTTP and adopts sent revision despite later normal save', async () => {
  const f = fixture(),
    route = await replacement(f)
  expect(f.active.size).toBe(2)
  route.beforeSend()
  f.save()
  route.accepted()
  route.finish('accepted')
  expect(f.session.accountId).toBe('B')
  expect(f.active).toEqual(new Set(['pending-1']))
  expect(f.release).toHaveBeenCalledExactlyOnceWith('initial-A')
  expect(f.selected).toHaveBeenCalledOnce()
  await f.session.dispose({ releaseCurrent: true })
  expect(f.active.size).toBe(0)
})
it('requires fresh replacement policy and quiet proof immediately before send', async () => {
  const f = fixture(),
    route = await replacement(f)
  f.save()
  expect(() => route.beforeSend()).toThrow('boundary changed')
  route.finish('not-sent')
  expect(f.active).toEqual(new Set(['initial-A']))
  const next = await replacement(f)
  f.setQuiet(false)
  expect(() => next.beforeSend()).toThrow('boundary changed')
  next.finish('not-sent')
  expect(f.active).toEqual(new Set(['initial-A']))
})
it('allows normal concurrent current-account requests during tools and normal policy saves', async () => {
  const f = fixture()
  f.setQuiet(false)
  const a = await f.session.prepareCurrent(signal()),
    b = await f.session.prepareCurrent(signal())
  f.save()
  a.beforeSend()
  b.beforeSend()
  a.accepted()
  b.accepted()
  a.finish('accepted')
  b.finish('accepted')
  expect(f.active).toEqual(new Set(['initial-A']))
  expect(await f.session.prepareReplacement(new Set(['quota-A']), signal())).toBeNull()
})
it.each(['not-sent', 'rejected'] as const)(
  'releases only pending B on %s and permits C without exceeding two leases',
  async (verdict) => {
    const f = fixture(),
      route = await replacement(f)
    if (verdict === 'rejected') {
      route.beforeSend()
    }
    route.finish(verdict)
    route.finish(verdict)
    expect(f.active).toEqual(new Set(['initial-A']))
    const c = await f.session.prepareReplacement(new Set(['quota-A', 'quota-B']), signal())
    expect(c?.accountId).toBe('C')
    expect(f.active.size).toBe(2)
    c?.finish('not-sent')
  }
)
it('retains ambiguous current plus pending and refuses a third candidate until proven launch closure', async () => {
  const f = fixture(),
    route = await replacement(f)
  route.beforeSend()
  route.finish('unverifiable')
  expect(f.session.ambiguous).toBe(true)
  await expect(
    f.session.prepareReplacement(new Set(['quota-A', 'quota-B']), signal())
  ).rejects.toThrow('unverifiable')
  expect(f.active.size).toBe(2)
  await f.session.dispose({ releaseCurrent: false })
  expect(f.active.size).toBe(2)
  await f.session.dispose({ releaseCurrent: true })
  expect(f.active.size).toBe(0)
})
it('retains pending on accepted response after genuine owner loss', async () => {
  const f = fixture(),
    route = await replacement(f)
  route.beforeSend()
  f.revoke()
  expect(() => route.accepted()).toThrow('ownership changed')
  route.finish('accepted')
  expect(f.active.size).toBe(2)
  expect(f.session.accountId).toBe('A')
})
it('retains failed retired-release ownership and retries it before allocating another candidate', async () => {
  const f = fixture(),
    route = await replacement(f)
  route.beforeSend()
  f.failRelease(true)
  expect(() => route.accepted()).not.toThrow()
  route.finish('accepted')
  expect(f.selected).toHaveBeenCalledOnce()
  await expect(
    f.session.prepareReplacement(new Set(['quota-A', 'quota-B']), signal())
  ).rejects.toThrow('unverifiable')
  expect(f.session.accountId).toBe('B')
  expect(f.active.size).toBe(2)
  f.failRelease(false)
  await f.session.dispose({ releaseCurrent: true })
  expect(f.active.size).toBe(0)
})
it('does not let presentation callback failure discard accepted B or its reply', async () => {
  const f = fixture(),
    route = await replacement(f)
  f.selected.mockImplementation(() => {
    throw new Error('Presentation only')
  })
  route.beforeSend()
  expect(() => route.accepted()).not.toThrow()
  route.finish('accepted')
  expect(f.session.accountId).toBe('B')
  expect(f.active.size).toBe(1)
})
it('releases a cancelled unpublished candidate and preserves current A', async () => {
  const f = fixture(),
    controller = new AbortController()
  f.refresh.mockImplementation(async (id: string) => {
    controller.abort()
    return {
      access: { accessToken: `synthetic-${id}`, expiresAt: 4_000_000_000_000, scopes: [] },
      identity: {
        accountUuid: id,
        organizationUuid: `org-${id}`,
        emailAddress: `${id}@example.invalid`
      }
    }
  })
  await expect(
    f.session.prepareReplacement(new Set(['quota-A']), controller.signal)
  ).rejects.toThrow()
  expect(f.active).toEqual(new Set(['initial-A']))
})

it('keeps an existing affiliated launch eligible when Apply to New is disabled', async () => {
  const f = fixture()
  f.stopApplyingToNew()
  const route = await replacement(f)
  route.beforeSend()
  route.accepted()
  route.finish('accepted')
  expect(f.session.accountId).toBe('B')
  expect(f.active.size).toBe(1)
})
