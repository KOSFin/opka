import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  cancelUnstartedDarwinRefresh,
  assertDarwinRefreshWriterAbsent
} from './claude-native-darwin-refresh-writer.mjs'
const missing = async () => {
  const error = new Error('absent')
  error.code = 'ENOENT'
  throw error
}
test('unused writer cancellation joins an asynchronous callback before checking both markers', async () => {
  let release,
    checks = 0,
    done = false
  const pending = cancelUnstartedDarwinRefresh(
    {
      onNotStarted: () =>
        new Promise((resolve) => {
          release = resolve
        })
    },
    '/owned/writer',
    async () => {
      checks++
      return missing()
    }
  ).then(() => {
    done = true
  })
  await Promise.resolve()
  assert.equal(checks, 0)
  assert.equal(done, false)
  release()
  await pending
  assert.equal(checks, 2)
})
test('existing or unreadable writer marker keeps cleanup unverified', async () => {
  for (const probe of [
    async () => ({}),
    async () => {
      throw new Error('private filesystem error')
    }
  ]) {
    await assert.rejects(
      assertDarwinRefreshWriterAbsent('/owned/writer', probe),
      (error) =>
        error.nativeCleanupUnverifiable === true &&
        !error.message.includes('private filesystem error')
    )
  }
})
test('rejected cancellation cannot be treated as an absent writer', async () => {
  let checked = false
  await assert.rejects(
    cancelUnstartedDarwinRefresh(
      {
        onNotStarted: async () => {
          throw new Error('private rejection')
        }
      },
      '/owned/writer',
      async () => {
        checked = true
      }
    ),
    (error) => error.nativeCleanupUnverifiable === true
  )
  assert.equal(checked, false)
})
