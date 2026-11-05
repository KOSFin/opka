import { afterEach, expect, it, vi } from 'vitest'
import { createClaudeNativeRefreshMonitor } from './claude-native-refresh-monitor'
const result = '{"type":"result","subtype":"success","is_error":false}\n'
afterEach(() => vi.useRealTimers())
it('reads only after a complete genuine successful local result and only once concurrently', async () => {
  const read = vi.fn().mockResolvedValue(true)
  const monitor = createClaudeNativeRefreshMonitor({ readFresh: read, timeoutMs: 45000 })
  monitor.onStdout('{"type":"result","subtype":"error","is_error":true}\n')
  expect(read).not.toHaveBeenCalled()
  monitor.onStdout(result.slice(0, 20))
  expect(read).not.toHaveBeenCalled()
  monitor.onStdout(result.slice(20))
  monitor.onStdout(result)
  await monitor.finish()
  expect(read).toHaveBeenCalledTimes(1)
  expect(monitor.successfulResult).toBe(true)
})
it('caps backoff at two seconds while allowing retries beyond two seconds within command budget', async () => {
  vi.useFakeTimers()
  const reads: number[] = []
  const monitor = createClaudeNativeRefreshMonitor({
    timeoutMs: 45000,
    readFresh: async () => {
      reads.push(Date.now())
      return reads.length === 9
    }
  })
  monitor.onStdout(result)
  await vi.advanceTimersByTimeAsync(10000)
  expect(reads).toHaveLength(9)
  expect(reads.at(-1)! - reads[0]).toBeGreaterThan(2000)
  expect(Math.max(...reads.slice(1).map((time, i) => time - reads[i]))).toBeLessThanOrEqual(2000)
  expect(monitor.readyStopped).toBe(true)
  await monitor.finish()
  expect(vi.getTimerCount()).toBe(0)
})
it('external cancellation joins an in-flight read and never labels it an owned ready stop', async () => {
  vi.useFakeTimers()
  let resolve!: (value: boolean) => void
  const controller = new AbortController()
  const monitor = createClaudeNativeRefreshMonitor({
    signal: controller.signal,
    timeoutMs: 45000,
    readFresh: () =>
      new Promise((done) => {
        resolve = done
      })
  })
  monitor.onStdout(result)
  controller.abort()
  let joined = false
  const finish = monitor.finish().then(() => {
    joined = true
  })
  await Promise.resolve()
  expect(joined).toBe(false)
  resolve(true)
  await finish
  expect(monitor.readyStopped).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
it('native close cancels a pending backoff and leaves no continuing reader', async () => {
  vi.useFakeTimers()
  const read = vi.fn().mockResolvedValue(false)
  const monitor = createClaudeNativeRefreshMonitor({ timeoutMs: 45000, readFresh: read })
  monitor.onStdout(result)
  await Promise.resolve()
  monitor.onClosed()
  await monitor.finish()
  await vi.advanceTimersByTimeAsync(10000)
  expect(read).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
it('overflow aborts without admitting a successful result or retaining its content', async () => {
  const read = vi.fn().mockResolvedValue(true)
  const monitor = createClaudeNativeRefreshMonitor({ timeoutMs: 45000, readFresh: read })
  monitor.onStdout('x'.repeat(65537))
  monitor.onStdout(result)
  expect(monitor.signal.aborted).toBe(true)
  expect(monitor.successfulResult).toBe(false)
  expect(read).not.toHaveBeenCalled()
  await monitor.finish()
})
it('read failures abort privately and never become a ready stop', async () => {
  const monitor = createClaudeNativeRefreshMonitor({
    timeoutMs: 45000,
    readFresh: async () => {
      throw new Error('private source')
    }
  })
  monitor.onStdout(result)
  await monitor.finish()
  expect(monitor.signal.aborted).toBe(true)
  expect(monitor.readyStopped).toBe(false)
})

it('deadline bounds source retries and joins without leaving timers', async () => {
  vi.useFakeTimers()
  const read = vi.fn().mockResolvedValue(false)
  const monitor = createClaudeNativeRefreshMonitor({ timeoutMs: 45000, readFresh: read })
  monitor.onStdout(result)
  await vi.advanceTimersByTimeAsync(45000)
  expect(monitor.signal.aborted).toBe(true)
  expect(monitor.readyStopped).toBe(false)
  expect(monitor.successfulResult).toBe(false)
  const attempts = read.mock.calls.length
  expect(attempts).toBeLessThanOrEqual(64)
  await monitor.finish()
  await vi.advanceTimersByTimeAsync(5000)
  expect(read).toHaveBeenCalledTimes(attempts)
  expect(vi.getTimerCount()).toBe(0)
})
