import { expect, it, vi } from 'vitest'
import type { NativeCliStdioEvent } from '../../shared/native-cli-stdio'
import { NativeCliStdioOutput } from './native-cli-stdio-output'
function fixture() {
  const pressure = vi.fn(),
    completed = vi.fn(),
    frames: NativeCliStdioEvent[] = []
  const output = new NativeCliStdioOutput(pressure, completed)
  return {
    output,
    pressure,
    completed,
    frames,
    attach: () => output.attach((frame) => frames.push(frame))
  }
}
it('preserves byte channels and frame ordering before and after attach', () => {
  const f = fixture()
  const bytes = Buffer.alloc(64 * 1024)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = i % 256
  }
  f.output.write('stdout', bytes)
  expect(f.frames).toHaveLength(0)
  f.attach()
  f.output.write('stderr', Buffer.from([0, 255, 10]))
  const rows = f.frames.filter((row) => row.type === 'native-stdio-output')
  expect(rows.map((row) => [row.sequence, row.channel])).toEqual([
    [1, 'stdout'],
    [2, 'stdout'],
    [3, 'stderr']
  ])
  expect(
    Buffer.compare(
      Buffer.concat(rows.slice(0, 2).map((row) => Buffer.from(row.bytes, 'base64'))),
      bytes
    )
  ).toBe(0)
  expect([...Buffer.from(rows[2].bytes, 'base64')]).toEqual([0, 255, 10])
})
it('pauses at128KiB and resumes only after a consumed cumulative acknowledgement', () => {
  const f = fixture()
  f.attach()
  f.output.write('stdout', Buffer.alloc(64 * 1024))
  expect(f.pressure).toHaveBeenLastCalledWith(false)
  f.output.write('stderr', Buffer.alloc(64 * 1024))
  expect(f.pressure).toHaveBeenLastCalledWith(true)
  f.output.acknowledge(2)
  expect(f.pressure).toHaveBeenLastCalledWith(false)
  expect(() => f.output.acknowledge(1)).not.toThrow()
  expect(() => f.output.acknowledge(5)).toThrow('out of sequence')
})
it('bounds the total unread window and recovers space only through sent ACKs', () => {
  const f = fixture()
  f.attach()
  for (let i = 0; i < 4; i++) {
    f.output.write('stdout', Buffer.alloc(64 * 1024))
  }
  expect(() => f.output.write('stderr', Buffer.alloc(1))).toThrow('bounded delivery window')
  f.output.acknowledge(1)
  expect(() => f.output.write('stderr', Buffer.alloc(32 * 1024))).not.toThrow()
  expect(() => f.output.write('stderr', Buffer.alloc(1))).toThrow('bounded delivery window')
})
it('rejects oversized individual chunks atomically', () => {
  const f = fixture()
  f.attach()
  expect(() => f.output.write('stdout', Buffer.alloc(64 * 1024 + 1))).toThrow(
    'bounded delivery window'
  )
  expect(f.frames).toHaveLength(0)
  f.output.write('stdout', Buffer.from('small'))
  expect(f.frames[0]).toMatchObject({ sequence: 1 })
})
it('does not permit ACKs for buffered bytes that were never sent', () => {
  const f = fixture()
  f.output.write('stdout', Buffer.from('buffered'))
  expect(() => f.output.acknowledge(1)).toThrow('out of sequence')
  f.attach()
  f.output.acknowledge(1)
})
it('publishes exit once only after the final bytes were consumed', () => {
  const f = fixture()
  f.attach()
  f.output.write('stdout', Buffer.from('last'))
  f.output.finish(7)
  expect(f.completed).not.toHaveBeenCalled()
  f.output.acknowledge(1)
  f.output.acknowledge(1)
  expect(f.frames.at(-1)).toEqual({ type: 'native-stdio-exit', code: 7 })
  expect(f.completed).toHaveBeenCalledOnce()
  expect(() => f.output.write('stderr', Buffer.from('late'))).toThrow('closure')
})
it('supports native exit before attachment without dropping buffered final output', () => {
  const f = fixture()
  f.output.write('stderr', Buffer.from('early'))
  f.output.finish(2)
  f.attach()
  expect(f.completed).not.toHaveBeenCalled()
  f.output.acknowledge(1)
  expect(f.frames.at(-1)).toEqual({ type: 'native-stdio-exit', code: 2 })
  expect(f.completed).toHaveBeenCalledOnce()
})
it('refuses multiple consumers and drops retained bytes on detach', () => {
  const f = fixture()
  f.output.write('stdout', Buffer.from('unread'))
  const detach = f.attach()
  expect(() => f.attach()).toThrow('output owner')
  detach()
  expect(() => f.attach()).toThrow('output owner')
  expect(() => f.output.write('stdout', Buffer.from('late'))).toThrow('closure')
  f.output.finish(1)
  expect(f.completed).not.toHaveBeenCalled()
})

it('settles and refuses reuse if the output owner throws during its initial flush', () => {
  const f = fixture()
  f.output.write('stdout', Buffer.from('synthetic'))
  expect(() =>
    f.output.attach(() => {
      throw new Error('closed synthetic sink')
    })
  ).toThrow('closed synthetic sink')
  expect(f.completed).toHaveBeenCalledOnce()
  expect(() => f.output.attach(() => {})).toThrow('already has an output owner')
  expect(() => f.output.write('stdout', Buffer.from('late'))).toThrow('closure')
})
