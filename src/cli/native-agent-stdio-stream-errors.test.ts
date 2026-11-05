import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { watchNativeAgentStdioErrors } from './native-agent-stdio-stream-errors'
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
it('contains repeated stream errors once without retaining raw error payloads', async () => {
  const stream = new EventEmitter(),
    failed = vi.fn(),
    existing = vi.fn()
  stream.on('error', existing)
  const dispose = watchNativeAgentStdioErrors([stream, stream], failed)
  stream.emit('error', new Error('private-1'))
  stream.emit('error', new Error('private-2'))
  expect(failed).toHaveBeenCalledExactlyOnceWith()
  dispose()
  await turn()
  expect(stream.listeners('error')).toEqual([existing])
})
it('keeps the sink for a deferred error after write callback rejection then removes it', async () => {
  const failed = vi.fn()
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('private EPIPE'))
    }
  })
  const dispose = watchNativeAgentStdioErrors([stream], failed)
  await new Promise<void>((resolve) =>
    stream.write('bytes', () => {
      dispose()
      resolve()
    })
  )
  await turn()
  expect(stream.listenerCount('error')).toBe(0)
  expect(failed.mock.calls.length).toBeLessThanOrEqual(1)
})
