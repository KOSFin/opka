import { expect, it, vi } from 'vitest'
import type { AccountPoolPolicy } from '../../shared/account-pool-policy'
import type { NativeClaudeHookRequest } from '../../shared/native-claude-hook'
import { createNativeClaudeRoutingSession } from './native-claude-routing-session'
function fixture(rotation: AccountPoolPolicy['rotation'] = 'after-turn', confirmedQuota?: boolean) {
  const policy: AccountPoolPolicy = {
    id: 'pool',
    provider: 'claude',
    revision: 1,
    strategy: 'balanced',
    applyToNewWork: true,
    rotation,
    unknownQuota: 'allow',
    allowReserve: false,
    members: [{ accountId: 'B', priority: 1, weight: 1, state: 'enabled', role: 'primary' }]
  }
  let active: AccountPoolPolicy | undefined = policy
  let boundary = true
  let idle = true
  let manual: string | null = null
  const release = vi.fn()
  const access = {
    access: { accessToken: 'fake-B', expiresAt: Date.now() + 60000, scopes: ['user:inference'] },
    identity: { accountUuid: 'B', organizationUuid: 'org-B', emailAddress: 'b@example.invalid' }
  }
  const acquire = vi.fn(({ ownerKey }: { ownerKey: string }) => ({
    ownerKey,
    accountId: 'B',
    provider: 'claude' as const,
    poolId: 'pool',
    policyRevision: 1,
    quotaIdentity: 'B',
    sequence: 1,
    releasedAt: null,
    ptyId: null,
    incarnationId: null
  }))
  const refresh = vi.fn(async () => access)
  const publish = vi.fn(async (_access: typeof access, canSwitch: () => boolean) => {
    if (!canSwitch()) {
      throw new Error('Changed boundary')
    }
  })
  const session = createNativeClaudeRoutingSession({
    launchId: 'launch',
    initialAccountId: 'A',
    ...(confirmedQuota !== undefined ? { confirmQuotaFailure: async () => confirmedQuota } : {}),
    initialOwnerKey: 'initial-A',
    db: { acquireAccountPoolAssignment: acquire, releaseAccountPoolAssignment: release },
    sources: {
      assertOwned: () => {},
      assertAccountOwned: () => {},
      refresh,
      readyAccountIds: async () => new Set(['B'])
    },
    facade: { publish },
    readPolicy: () => active,
    readManualAccountId: () => manual,
    readCandidates: () => [],
    readOwner: () => ({ identity: 'owned-pty', sessionId: 'native-session' }),
    readBoundary: () => ({
      canSwitch: () => boundary,
      onBoundaryAccepted: () => {
        boundary = false
      }
    }),
    readIdleBoundary: () => ({ canSwitch: () => idle, onBoundaryAccepted: () => {} }),
    readCompletedSuccessfully: () => true
  })
  function request(
    event: 'prompt',
    promptId?: string
  ): Extract<NativeClaudeHookRequest, { event: 'prompt' }>
  function request(
    event: 'failure',
    promptId?: string
  ): Extract<NativeClaudeHookRequest, { event: 'failure' }>
  function request(
    event: 'stop',
    promptId?: string
  ): Extract<NativeClaudeHookRequest, { event: 'stop' }>
  function request(
    event: 'prompt' | 'failure' | 'stop',
    promptId = 'prompt'
  ): NativeClaudeHookRequest {
    const common = {
      launchId: 'launch',
      capability: 'synthetic-private-capability-00000',
      sessionId: 'native-session',
      promptId
    }
    if (event === 'failure') {
      return { ...common, event, error: 'rate_limit' }
    }
    return { ...common, event }
  }

  return {
    session,
    request,
    acquire,
    refresh,
    publish,
    release,
    policy: (value: AccountPoolPolicy | undefined) => {
      active = value
    },
    idle: (value: boolean) => {
      idle = value
    },
    manual: (value: string | null) => {
      manual = value
    },
    saved: policy
  }
}
it('admits from the saved pool, refreshes only the source, publishes at Stop and hands off one lease', async () => {
  const f = fixture()
  await f.session.handle(f.request('stop'))
  expect(f.session.accountId()).toBe('B')
  expect(f.refresh).toHaveBeenCalledWith('B', expect.any(AbortSignal))
  expect(f.publish).toHaveBeenCalledOnce()
  expect(f.release).toHaveBeenCalledWith('initial-A')
  await f.session.dispose()
  expect(f.release).toHaveBeenCalledTimes(2)
})
it('reads live OFF/on-limit policy without after-turn publication', async () => {
  const f = fixture('on-limit')
  await f.session.handle(f.request('stop'))
  f.policy(undefined)
  await f.session.handle(f.request('stop'))
  expect(f.acquire).not.toHaveBeenCalled()
  await f.session.dispose()
})
it('drops a prepared lease when live policy changes during source refresh', async () => {
  const f = fixture()
  f.refresh.mockImplementationOnce(async () => {
    f.policy({ ...f.saved, revision: 2 })
    return {
      access: { accessToken: 'fake', expiresAt: Date.now() + 60000, scopes: ['user:inference'] },
      identity: { accountUuid: 'B', organizationUuid: 'org-B', emailAddress: 'b@example.invalid' }
    }
  })
  await expect(f.session.handle(f.request('stop'))).rejects.toThrow('changed')
  expect(f.publish).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.session.accountId()).toBe('A')
  await f.session.dispose()
})
it('allows racing real input immediately and prevents delayed Stop publication', async () => {
  const f = fixture()
  let finish = () => {}
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  const original = await f.refresh()
  f.refresh.mockImplementationOnce(async () => {
    await held
    return original
  })
  const stop = f.session.handle(f.request('stop'))
  await vi.waitFor(() => expect(f.acquire).toHaveBeenCalledOnce())
  expect(await f.session.handle(f.request('prompt', 'new-real-user-prompt'))).toEqual({
    action: 'allow'
  })
  finish()
  await expect(stop).rejects.toThrow('boundary')
  expect(f.session.accountId()).toBe('A')
  await f.session.dispose()
})

it('continues an owned failed prompt only through two signed native wakes and a coherent lease handoff', async () => {
  const f = fixture()
  await f.session.handle(f.request('prompt'))
  const failed = await f.session.handle(f.request('failure'))
  if (failed.action !== 'prepared') {
    throw new Error('Expected prepared failure')
  }
  const one = await f.session.handle({
    ...f.request('prompt'),
    event: 'claim-wake',
    phaseId: failed.phaseId,
    step: 1
  })
  if (one.action !== 'wake') {
    throw new Error('Expected first native wake')
  }
  const fresh = f.session.handle({
    ...f.request('prompt', 'native-wake-one'),
    event: 'fresh-wake',
    wakeMarker: one.marker
  })
  expect(
    await f.session.handle({ ...f.request('prompt', 'native-wake-one'), wakeMarker: one.marker })
  ).toEqual({ action: 'block' })
  const two = await fresh
  if (two.action !== 'wake') {
    throw new Error('Expected fresh native wake')
  }
  expect(
    await f.session.handle({ ...f.request('prompt', 'native-wake-two'), wakeMarker: two.marker })
  ).toEqual({ action: 'allow' })
  expect(f.session.accountId()).toBe('B')
  expect(f.publish).toHaveBeenCalledOnce()
  expect(f.release).toHaveBeenCalledWith('initial-A')
  await f.session.dispose()
})
it('allows a new user prompt once and retires an older prepared failure lease without publication', async () => {
  const f = fixture()
  await f.session.handle(f.request('prompt'))
  const failed = await f.session.handle(f.request('failure'))
  if (failed.action !== 'prepared') {
    throw new Error('Expected prepared failure')
  }
  expect(await f.session.handle(f.request('prompt', 'new-user-request'))).toEqual({
    action: 'allow'
  })
  expect(
    await f.session.handle({
      ...f.request('prompt'),
      event: 'claim-wake',
      phaseId: failed.phaseId,
      step: 1
    })
  ).toEqual({ action: 'none' })
  expect(f.publish).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.session.accountId()).toBe('A')
  await f.session.dispose()
})

it('applies the saved manual default after the pool is disabled without allocating another pool lease', async () => {
  const f = fixture()
  f.policy(undefined)
  f.manual('B')
  await f.session.handle(f.request('stop'))
  expect(f.session.accountId()).toBe('B')
  expect(f.acquire).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledWith('initial-A')
  await f.session.dispose()
})

it('applies a policy saved after a completed Stop while strictly idle before allowing the next real prompt', async () => {
  const f = fixture('on-limit')
  f.policy({ ...f.saved, revision: 2 })
  expect(await f.session.applyIdlePolicy()).toBe(true)
  expect(f.session.accountId()).toBe('B')
  expect(f.acquire).toHaveBeenCalledWith(
    expect.objectContaining({
      replacesOwnerKey: 'initial-A',
      policy: expect.objectContaining({ revision: 2 })
    })
  )
  expect(await f.session.handle(f.request('prompt', 'after-save-ack'))).toEqual({ action: 'allow' })
  expect(f.publish).toHaveBeenCalledOnce()
  expect(await f.session.applyIdlePolicy()).toBe(false)
  await f.session.dispose()
})
it('keeps a busy saved policy pending and applies it at the later completed boundary even in on-limit mode', async () => {
  const f = fixture('on-limit')
  f.idle(false)
  f.policy({ ...f.saved, revision: 2 })
  expect(await f.session.applyIdlePolicy()).toBe(false)
  expect(f.acquire).not.toHaveBeenCalled()
  f.idle(true)
  await f.session.handle(f.request('stop'))
  expect(f.session.accountId()).toBe('B')
  expect(f.publish).toHaveBeenCalledOnce()
  await f.session.dispose()
})

it('keeps an OFF pool owner pinned instead of applying an unrelated manual default', async () => {
  const f = fixture('off')
  f.manual('B')
  f.policy({ ...f.saved, rotation: 'off', revision: 2 })
  await f.session.handle(f.request('stop'))
  expect(f.session.accountId()).toBe('A')
  expect(f.refresh).not.toHaveBeenCalled()
  expect(f.publish).not.toHaveBeenCalled()
  expect(f.release).not.toHaveBeenCalled()
  await f.session.applyIdlePolicy()
  expect(f.release).not.toHaveBeenCalled()
  await f.session.dispose()
})

it('keeps a generic rate-limit failure on its account when subscription exhaustion is unconfirmed', async () => {
  const f = fixture('on-limit', false)
  await f.session.handle(f.request('prompt'))
  expect(await f.session.handle(f.request('failure'))).toEqual({ action: 'none' })
  expect(f.acquire).not.toHaveBeenCalled()
  expect(f.publish).not.toHaveBeenCalled()
  expect(f.session.accountId()).toBe('A')
  await f.session.dispose()
})
