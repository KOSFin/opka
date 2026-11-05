import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDarwinRefreshSecurityCommand } from './claude-native-darwin-refresh-security-command.mjs'

test('actual host termination callback proves closure with an ordinary ProcessResult', async () => {
  const raw = { code: 0, timedOut: false, outputTruncated: false }
  const observed = await runDarwinRefreshSecurityCommand(['fake'], async (options) => {
    assert.equal(options.terminationBarrier, true)
    assert.equal(options.maxOutputBytes, 4096)
    options.onChildTerminated()
    return raw
  })
  assert.deepEqual(observed, { result: raw, terminationObserved: true })
  assert.equal(Object.hasOwn(raw, 'terminationObserved'), false)
})
test('a result field cannot forge host termination proof', async () => {
  const observed = await runDarwinRefreshSecurityCommand(['fake'], async () => ({
    code: 0,
    terminationObserved: true
  }))
  assert.equal(observed.terminationObserved, false)
})
test('process failure propagates without fabricating a successful cleanup', async () => {
  await assert.rejects(
    runDarwinRefreshSecurityCommand(['fake'], async () => {
      throw new Error('unverifiable')
    }),
    /unverifiable/
  )
})
