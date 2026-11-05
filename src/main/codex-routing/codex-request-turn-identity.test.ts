import { expect, it } from 'vitest'
import { readCodexRequestTurnIdentity } from './codex-request-turn-identity'

it('reads the native header identity without retaining unrelated metadata', () => {
  expect(
    readCodexRequestTurnIdentity(
      JSON.stringify({
        thread_id: 'thread',
        turn_id: '0',
        parent_thread_id: 'parent',
        root_turn_id: 'root',
        unrelated: 'must-not-be-retained'
      })
    )
  ).toEqual({ threadId: 'thread', turnId: '0', parentThreadId: 'parent', rootTurnId: 'root' })
})

it.each([
  undefined,
  '',
  'not-json',
  '{}',
  '[1]',
  ['duplicate', 'header'],
  '{"thread_id":"t","turn_id":1}',
  ' '.repeat(16_385)
])('refuses unavailable or unverified native turn metadata: %j', (value) => {
  expect(readCodexRequestTurnIdentity(value)).toBeUndefined()
})

it('distinguishes captured native title generation from a main conversation ROOT', () => {
  const metadata = {
    thread_id: 'title-thread',
    turn_id: 'title-turn',
    thread_source: 'thread_title'
  }
  expect(readCodexRequestTurnIdentity(JSON.stringify(metadata))).toEqual({
    threadId: 'title-thread',
    turnId: 'title-turn',
    auxiliary: true
  })
  expect(
    readCodexRequestTurnIdentity(JSON.stringify({ ...metadata, thread_source: 'user' }))
  ).not.toHaveProperty('auxiliary')
})
