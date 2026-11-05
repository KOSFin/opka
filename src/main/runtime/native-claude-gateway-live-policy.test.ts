import { expect, it, vi } from 'vitest'
import { fixture, replacement } from './native-claude-gateway-route-fixture'

it('uses the shared after-turn coordinator to adopt a new host route without facade publication', async () => {
  const f = fixture()
  f.rotation('after-turn')
  f.prefer('B')
  expect(await f.session.applyAtBoundary(f.boundary())).toBe(true)
  expect(f.session.assignment()).toEqual({ accountId: 'B', ownerKey: 'pending-1' })
  expect(f.active).toEqual(new Set(['pending-1']))
  expect(f.acceptedBoundary).toHaveBeenCalledOnce()
  expect(f.session.usesAccount('B')).toBe(true)
  await f.session.dispose({ releaseCurrent: true })
})

it('applies an idle saved policy before the next native request and acknowledges it only once', async () => {
  const f = fixture()
  f.save()
  f.prefer('B')
  expect(await f.session.applyIdlePolicy()).toBe(true)
  expect(f.session.accountId).toBe('B')
  expect(await f.session.applyIdlePolicy()).toBe(false)
  expect(f.selected).toHaveBeenCalledOnce()
  await f.session.dispose({ releaseCurrent: true })
})

it('retains a busy save pending until a later genuine completed boundary', async () => {
  const f = fixture()
  f.idle(false)
  f.save()
  f.prefer('C')
  expect(await f.session.applyIdlePolicy()).toBe(false)
  expect(f.active).toEqual(new Set(['initial-A']))
  f.idle(true)
  expect(await f.session.applyAtBoundary(f.boundary())).toBe(true)
  expect(f.session.accountId).toBe('C')
  await f.session.dispose({ releaseCurrent: true })
})

it('keeps an OFF affiliated account pinned, then resumes saved pool policy on reenable', async () => {
  const f = fixture()
  f.manual('C')
  f.rotation('off')
  expect(await f.session.applyIdlePolicy()).toBe(true)
  expect(f.session.accountId).toBe('A')
  expect(f.refresh).not.toHaveBeenCalled()
  expect(f.active).toEqual(new Set(['initial-A']))
  f.rotation('on-limit')
  f.prefer('B')
  expect(await f.session.applyIdlePolicy()).toBe(true)
  expect(f.session.accountId).toBe('B')
  await f.session.dispose({ releaseCurrent: true })
})

it('reuses existing manual-default publication without allocating a pool assignment', async () => {
  const f = fixture()
  f.removePolicy()
  f.manual('B')
  expect(await f.session.applyIdlePolicy()).toBe(true)
  expect(f.session.assignment()).toEqual({ accountId: 'B', ownerKey: undefined })
  expect(f.active.size).toBe(0)
  expect(f.release).toHaveBeenCalledExactlyOnceWith('initial-A')
  await f.session.dispose({ releaseCurrent: true })
})

it('keeps Save R+1 pending when quota B accepts a request admitted under R', async () => {
  const f = fixture(),
    route = await replacement(f)
  route.beforeSend()
  f.save()
  route.accepted()
  route.finish('accepted')
  expect(f.session.accountId).toBe('B')
  f.prefer('C')
  expect(await f.session.applyIdlePolicy()).toBe(true)
  expect(f.session.accountId).toBe('C')
  expect(f.selected).toHaveBeenCalledTimes(2)
  expect(f.active.size).toBe(1)
  await f.session.dispose({ releaseCurrent: true })
})

it('checks the full manual affiliation stamp before a replacement POST', async () => {
  const f = fixture(),
    route = await replacement(f)
  f.manual('C')
  expect(() => route.beforeSend()).toThrow('boundary changed')
  route.finish('not-sent')
  expect(f.active).toEqual(new Set(['initial-A']))
  await f.session.dispose({ releaseCurrent: true })
})

it('rejects delayed idle publication when new canonical input changes during refresh', async () => {
  const f = fixture()
  const original = await f.refresh('B')
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  f.refresh.mockImplementationOnce(async () => {
    await held
    return original
  })
  f.save()
  f.prefer('B')
  const applying = f.session.applyIdlePolicy()
  await vi.waitFor(() => expect(f.active.size).toBe(2))
  f.changeInput()
  release()
  await expect(applying).rejects.toThrow('boundary changed')
  expect(f.session.accountId).toBe('A')
  expect(f.active).toEqual(new Set(['initial-A']))
  expect(f.selected).not.toHaveBeenCalled()
  await f.session.dispose({ releaseCurrent: true })
})

it('pins manual policy saves after an ambiguous send without losing the retained candidate', async () => {
  const f = fixture(),
    route = await replacement(f)
  route.beforeSend()
  route.finish('unverifiable')
  const refreshes = f.refresh.mock.calls.length
  f.removePolicy()
  f.manual('C')
  expect(await f.session.applyIdlePolicy()).toBe(false)
  expect(await f.session.applyAtBoundary(f.boundary())).toBe(false)
  expect(f.refresh.mock.calls.length).toBe(refreshes)
  expect(f.session.accountId).toBe('A')
  expect(f.session.usesAccount('B')).toBe(true)
  expect(f.active).toEqual(new Set(['initial-A', 'pending-1']))
  await f.session.dispose({ releaseCurrent: true })
  expect(f.active.size).toBe(0)
})
