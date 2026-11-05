import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runDarwinRefreshPreflight } from './claude-native-darwin-refresh-preflight.mjs'
import {
  qualifyDarwinRefreshCache,
  assertDarwinRefreshAccess
} from './claude-native-darwin-refresh-cache.mjs'
const lookups = () =>
  Array.from({ length: 4 }, () => ({ code: 44, timedOut: false, outputTruncated: false }))
const write = (explicit) => ({
  explicit,
  write: { code: 0, timedOut: false, terminationObserved: true },
  readMatched: true,
  readTerminationObserved: true,
  cleanupVerified: true
})
function fixture(mode = 'isolated-no-keychain') {
  const calls = []
  const probes = {
    domain: async () => {
      calls.push('domain')
      return { mode }
    },
    lookups: async () => {
      calls.push('lookups')
      return lookups()
    },
    writes: async (options) => {
      calls.push('writes')
      for (const explicit of mode === 'owned-default' ? [false, true, false, true] : [true, true]) {
        options.onObservation(write(explicit))
      }
      return { mode }
    }
  }
  return { calls, probes }
}
test('namespace verification precedes all absence lookups and only explicit controls qualify no-default mode', async () => {
  const f = fixture()
  const value = await runDarwinRefreshPreflight({}, f.probes)
  assert.deepEqual(f.calls, ['domain', 'lookups', 'writes'])
  assert.equal(value.writes.length, 2)
  assert.equal(value.ownedDefault, false)
})
test('owned-default mode preserves all four explicit/implicit controls', async () => {
  const f = fixture('owned-default')
  const value = await runDarwinRefreshPreflight({}, f.probes)
  assert.equal(value.ownedDefault, true)
  assert.equal(value.writes.length, 4)
})
test('unknown domain performs no lookup or write', async () => {
  const f = fixture('unverifiable')
  await assert.rejects(runDarwinRefreshPreflight({}, f.probes))
  assert.deepEqual(f.calls, ['domain'])
})
test('changed namespace and unproven write cleanup refuse qualification', async () => {
  const f = fixture()
  f.probes.writes = async (options) => {
    options.onObservation({ ...write(true), cleanupVerified: false })
    options.onObservation(write(true))
    return { mode: 'isolated-no-keychain' }
  }
  await assert.rejects(runDarwinRefreshPreflight({}, f.probes))
  f.probes.writes = async () => ({ mode: 'owned-default' })
  await assert.rejects(runDarwinRefreshPreflight({}, f.probes))
})
test('no-default mode never accepts an implicit write receipt', async () => {
  const f = fixture()
  f.probes.writes = async (options) => {
    options.onObservation(write(false))
    options.onObservation(write(true))
    return { mode: 'isolated-no-keychain' }
  }
  await assert.rejects(runDarwinRefreshPreflight({}, f.probes))
})
test('four cached reads require exact owned-HOME footprint and validated projections', async () => {
  let reads = 0,
    validated = 0
  const measurements = await qualifyDarwinRefreshCache({
    initial: { files: 8, bytes: 5436 },
    read: async () => {
      reads++
      return {}
    },
    validate: () => {
      validated++
    },
    measure: async () => ({ files: 8, bytes: 5436 })
  })
  assert.equal(reads, 4)
  assert.equal(validated, 4)
  assert.equal(measurements.length, 4)
  for (const changed of [
    { files: 9, bytes: 5436 },
    { files: 8, bytes: 5437 }
  ]) {
    await assert.rejects(
      qualifyDarwinRefreshCache({
        initial: { files: 8, bytes: 5436 },
        read: async () => ({}),
        validate: () => {},
        measure: async () => changed
      }),
      /footprint/
    )
  }
})
test('cached projection failure stops immediately rather than claiming four reads', async () => {
  let reads = 0
  await assert.rejects(
    qualifyDarwinRefreshCache({
      initial: { files: 8, bytes: 5436 },
      read: async () => {
        reads++
        return {}
      },
      validate: () => {
        throw new Error('fixed invalid projection')
      },
      measure: async () => ({ files: 8, bytes: 5436 })
    })
  )
  assert.equal(reads, 1)
})

test('cached access validation keeps exact account identity and excludes native refresh credentials', () => {
  const identity = {
    accountUuid: 'fake-account',
    organizationUuid: 'fake-org',
    emailAddress: 'fake@example.invalid'
  }
  const expected = { identity, accessToken: 'fake-access', refreshToken: 'synthetic-refresh' }
  const snapshot = { identity, access: { accessToken: 'fake-access' } }
  assert.doesNotThrow(() => assertDarwinRefreshAccess(snapshot, expected))
  for (const bad of [
    { ...snapshot, identity: { ...identity, accountUuid: 'other' } },
    { ...snapshot, identity: { ...identity, organizationUuid: 'other' } },
    { ...snapshot, identity: { ...identity, emailAddress: 'other@example.invalid' } },
    { ...snapshot, access: { ...snapshot.access, refreshToken: 'synthetic-refresh' } }
  ]) {
    assert.throws(() => assertDarwinRefreshAccess(bad, expected), /identity|refresh credentials/)
  }
})

test('cached native access rejects changed link counts even with identical file bytes', async () => {
  await assert.rejects(
    qualifyDarwinRefreshCache({
      initial: { files: 1, bytes: 10, links: 0 },
      read: async () => ({}),
      validate() {},
      measure: async () => ({ files: 1, bytes: 10, links: 1 })
    }),
    /changed the owned HOME/
  )
})
