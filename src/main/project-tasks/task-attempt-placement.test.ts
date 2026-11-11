import { afterEach, expect, it } from 'vitest'
import { taskResultFixture } from './task-result-test-fixture'
import {
  captureTaskSessionPlacement,
  readTaskSessionPlacement,
  requireTaskSourcePlacement
} from './task-attempt-placement'
import { delegationDigest } from './task-delegation-policy'
const fixtures: ReturnType<typeof taskResultFixture>[] = []
afterEach(() => fixtures.splice(0).forEach((h) => h.db.close()))
it('binds immutable session placement to its exact reserved author and attempt', () => {
  const h = taskResultFixture()
  fixtures.push(h)
  const placement = {
    workspaceId: 'folder-source',
    executionHostId: 'local' as const,
    worktreePath: '/synthetic',
    owner: h.implementer.actor
  }
  expect(() => readTaskSessionPlacement(h.store, h.implementation.id)).toThrow(/provenance/)
  expect(() =>
    h.store.transaction(() =>
      captureTaskSessionPlacement(h.store, h.implementation.id, {
        ...placement,
        owner: h.reviewer.actor
      })
    )
  ).toThrow(/owner/)
  h.store.transaction(() => captureTaskSessionPlacement(h.store, h.implementation.id, placement))
  expect(readTaskSessionPlacement(h.store, h.implementation.id)).toEqual(placement)
  expect(() =>
    h.store.transaction(() =>
      captureTaskSessionPlacement(h.store, h.implementation.id, {
        ...placement,
        worktreePath: '/unrelated'
      })
    )
  ).toThrow(/immutable/)
  const source = {
    workspaceId: placement.workspaceId,
    worktreePath: placement.worktreePath,
    placementDigest: delegationDigest({ attemptId: h.implementation.id, ...placement })
  }
  requireTaskSourcePlacement(h.store, h.implementation.id, source)
  expect(() => requireTaskSourcePlacement(h.store, h.review.id, source)).toThrow(/provenance/)
  expect(() =>
    requireTaskSourcePlacement(h.store, h.implementation.id, { ...source, workspaceId: 'other' })
  ).toThrow(/provenance/)
})
