import { expect, it, vi } from 'vitest'
import { createClaudeNativeHookPhase } from './claude-native-hook-phase'

function fixture() {
  let owner: string | null = 'physical-cli-A'
  let policy: string | null = 'saved-policy-1'
  let boundary = true
  let completed = false
  const accepted = vi.fn()
  const publish = vi.fn(async (_snapshot: string, canSwitch: () => boolean) => {
    if (!canSwitch()) {
      throw new Error('boundary-changed')
    }
  })
  const select = vi.fn(async (_excluded: ReadonlySet<string>) => ({
    accountId: 'B',
    snapshot: 'fresh-B'
  }))
  const phase = createClaudeNativeHookPhase({
    readOwner: () => owner,
    readPolicy: () => policy,
    readBoundary: () => ({ canSwitch: () => boundary, onBoundaryAccepted: accepted }),
    readCompletedSuccessfully: () => completed,
    select,
    publish
  })
  return {
    phase,
    publish,
    select,
    accepted,
    owner: (value: string | null) => {
      owner = value
    },
    policy: (value: string | null) => {
      policy = value
    },
    boundary: (value: boolean) => {
      boundary = value
    },
    completed: (value: boolean) => {
      completed = value
    }
  }
}
async function failed(f: ReturnType<typeof fixture>, promptId = 'original') {
  await f.phase.prompt(promptId, 'an actual new user task', () => true)
  const id = await f.phase.failure(promptId, 'A')
  if (!id) {
    throw new Error('Expected a qualified failure phase')
  }
  return id
}
function claimed(f: ReturnType<typeof fixture>, id: string, step: 1 | 2) {
  const wake = f.phase.claimWake(id, step)
  if (!wake) {
    throw new Error('Expected a one-use native wake')
  }
  return wake
}

it('publishes only while blocking its signed stale wake, then allows exactly one fresh native wake', async () => {
  const f = fixture()
  const id = await failed(f)
  expect(f.publish).not.toHaveBeenCalled()
  const one = claimed(f, id, 1)
  expect(f.phase.claimWake(id, 1)).toBeNull()
  expect(
    await f.phase.prompt('stale-wake', `Continue the existing task. ${one.marker}`, () => true)
  ).toBe('block')
  expect(f.publish).toHaveBeenCalledOnce()
  expect(f.accepted).toHaveBeenCalledOnce()
  const two = claimed(f, id, 2)
  expect(
    await f.phase.prompt('fresh-wake', `Continue the existing task. ${two.marker}`, () => true)
  ).toBe('allow')
  expect(f.phase.claimWake(id, 2)).toBeNull()
  expect(await f.phase.prompt('replayed-wake', two.marker, () => true)).toBe('block')
})

it('allows racing real input unchanged, cancels the old wake and resumes only the latest failed native history', async () => {
  const f = fixture()
  const id = await failed(f)
  const old = claimed(f, id, 1)
  expect(await f.phase.prompt('new-user', 'a unique brand new request', () => true)).toBe('allow')
  expect(f.phase.claimWake(id, 2)).toBeNull()
  expect(await f.phase.prompt('late-old-wake', old.marker, () => true)).toBe('block')
  expect(f.publish).not.toHaveBeenCalled()
  expect(await f.phase.failure('original', 'A')).toBeNull()
  const next = await f.phase.failure('new-user', 'A')
  expect(next).not.toBeNull()
  expect(next).not.toBe(id)
})

it('rejects changed owner, saved policy, children/boundary and closed hook call before publication', async () => {
  for (const invalidate of ['owner', 'policy', 'boundary', 'call'] as const) {
    const f = fixture()
    const id = await failed(f)
    const one = claimed(f, id, 1)
    if (invalidate === 'owner') {
      f.owner('other-physical-cli')
    }
    if (invalidate === 'policy') {
      f.policy('saved-policy-2')
    }
    if (invalidate === 'boundary') {
      f.boundary(false)
    }
    expect(await f.phase.prompt('stale-wake', one.marker, () => invalidate !== 'call')).toBe(
      'block'
    )
    expect(f.phase.claimWake(id, 2)).toBeNull()
    if (invalidate !== 'boundary') {
      expect(f.publish).not.toHaveBeenCalled()
    }
    expect(f.accepted).not.toHaveBeenCalled()
  }
})

it('cancels an asynchronous selection when new user input arrives, with no late account overwrite', async () => {
  const f = fixture()
  let finish: (value: { accountId: string; snapshot: string }) => void = () => {}
  f.select.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await f.phase.prompt('original', 'first task', () => true)
  const preparing = f.phase.failure('original', 'A')
  await f.phase.prompt('new-user', 'unique new task', () => true)
  finish({ accountId: 'B', snapshot: 'late-B' })
  expect(await preparing).toBeNull()
  expect(f.publish).not.toHaveBeenCalled()
})

it('never cycles back to an attempted identity before a successful canonical completion', async () => {
  const f = fixture()
  const id = await failed(f)
  const one = claimed(f, id, 1)
  await f.phase.prompt('stale', one.marker, () => true)
  const two = claimed(f, id, 2)
  await f.phase.prompt('fresh', two.marker, () => true)
  f.select.mockResolvedValue({ accountId: 'A', snapshot: 'fresh-A' })
  expect(await f.phase.failure('fresh', 'B')).toBeNull()
  expect(f.select.mock.calls.at(-1)?.[0]).toEqual(new Set(['A', 'B']))
  f.completed(true)
  f.phase.completed()
  await f.phase.prompt('new-task', 'new real task', () => true)
  expect(await f.phase.failure('new-task', 'B')).not.toBeNull()
})

it('deduplicates failure and helper claims and refuses all further automatic admission after disposal', async () => {
  const f = fixture()
  const id = await failed(f)
  expect(await f.phase.failure('original', 'A')).toBe(id)
  expect(f.select).toHaveBeenCalledOnce()
  claimed(f, id, 1)
  f.phase.dispose()
  expect(f.phase.claimWake(id, 1)).toBeNull()
  expect(await f.phase.prompt('new', 'a user task', () => true)).toBe('block')
  expect(await f.phase.failure('new', 'A')).toBeNull()
})

it('starts a new bounded identity budget for a distinct accepted real task, without resetting for internal wakes', async () => {
  const f = fixture(),
    id = await failed(f),
    one = claimed(f, id, 1)
  await f.phase.prompt('stale', one.marker, () => true)
  const two = claimed(f, id, 2)
  await f.phase.prompt('fresh', two.marker, () => true)
  f.select.mockResolvedValue({ accountId: 'A', snapshot: 'fresh-A' })
  expect(await f.phase.failure('fresh', 'B')).toBeNull()
  await f.phase.prompt('new-real-task', 'new task', () => true)
  expect(await f.phase.failure('new-real-task', 'B')).not.toBeNull()
  expect(f.select.mock.calls.at(-1)?.[0]).toEqual(new Set(['B']))
})
