import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeTestStores, createStore, testState } from '../../persistence-test-harness'

describe('automation command host epoch', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'automation-host-epoch-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('persists one monotonic boot generation through the existing profile authority', async () => {
    const first = createStore()
    expect(first.getCommandHostEpoch()).toBe(0)
    expect(first.advanceCommandHostEpoch()).toBe(1)
    await first.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await closeTestStores()
    const restarted = createStore()
    expect(restarted.getCommandHostEpoch()).toBe(1)
    expect(restarted.advanceCommandHostEpoch()).toBe(2)
    await restarted.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    expect(restarted.getCommandHostEpoch()).toBe(2)
  })
})
