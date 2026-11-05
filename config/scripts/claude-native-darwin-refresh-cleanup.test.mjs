import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  finishDarwinRefreshCleanup,
  summarizeDarwinRefreshSecurityCommand,
  mutateDarwinRefreshKeychainSource
} from './claude-native-darwin-refresh-cleanup.mjs'

test('cleanup failure records safe flags and preserves the original qualification error', async () => {
  const primaryError = new Error('original file-byte guard')
  let observed
  await finishDarwinRefreshCleanup({
    primaryError,
    close: async () => {
      throw new Error('secondary delete failure')
    },
    record: async (value) => {
      observed = value
    }
  })
  assert.deepEqual(observed, { failed: true })
  assert.equal(primaryError.message, 'original file-byte guard')
  assert.equal(primaryError.nativeCleanupUnverifiable, true)
})
test('cleanup-only failure still fails qualification', async () => {
  await assert.rejects(
    finishDarwinRefreshCleanup({
      close: async () => {
        throw new Error('failed')
      },
      record: async () => {}
    }),
    /cleanup is unverified/
  )
})
test('diagnostic write failure cannot override a primary guard either', async () => {
  const primaryError = new Error('primary')
  await finishDarwinRefreshCleanup({
    primaryError,
    close: async () => {},
    record: async () => {
      throw new Error('write failed')
    }
  })
  assert.equal(primaryError.nativeCleanupUnverifiable, true)
})
test('cleanup metadata retains truncation even for a successfully terminated delete without leaking output', () => {
  const summary = summarizeDarwinRefreshSecurityCommand({
    result: {
      code: 0,
      outputTruncated: true,
      timedOut: false,
      stdout: 'private attributes',
      stderr: 'private account'
    },
    terminationObserved: true
  })
  assert.deepEqual(summary, {
    code: 0,
    signal: null,
    timedOut: false,
    outputTruncated: true,
    terminationObserved: true
  })
  assert.equal(JSON.stringify(summary).includes('private'), false)
})

test('a truncated successful delete is recorded and still rejected', async () => {
  let recorded
  await assert.rejects(
    mutateDarwinRefreshKeychainSource(
      {
        kind: 'delete',
        service: 'fake-source',
        keychain: '/fake-owned',
        onObservation: (value) => {
          recorded = value
        }
      },
      async (args) => {
        assert.equal(args[0], 'delete-generic-password')
        assert.equal(args.at(-1), '/fake-owned')
        return { result: { code: 0, outputTruncated: true }, terminationObserved: true }
      }
    ),
    /mutation is unverified/
  )
  assert.equal(recorded.outputTruncated, true)
  assert.equal(recorded.terminationObserved, true)
})
