import { expect, it, vi } from 'vitest'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { spawnManagedProviderProcess } from './managed-provider-process'
it('contains raw stdin errors, preserves byte channels and removes its own listener at close', () => {
  const child = createFakePipedChild(),
    onInputError = vi.fn(),
    onOutputError = vi.fn(),
    existing = vi.fn(),
    stdout = vi.fn(),
    stderr = vi.fn()
  const spawn = vi.fn<PipedProcessSpawner>(() => child)
  child.stdin.on('error', existing)
  const managed = spawnManagedProviderProcess(
    { command: 'fake-native', args: [] },
    {
      site: 'raw-fixture',
      platform: 'win32',
      spawnImpl: spawn,
      rawOutput: { stdout, stderr, onInputError, onOutputError }
    }
  )
  const error = new Error('synthetic EPIPE')
  expect(() => child.stdin.emit('error', error)).not.toThrow()
  expect(onInputError).toHaveBeenCalledExactlyOnceWith(error)
  child.stdout.emit('error', error)
  child.stderr.emit('error', error)
  expect(onOutputError.mock.calls).toEqual([
    ['stdout', error],
    ['stderr', error]
  ])
  const bytes = Buffer.from([0, 255, 10])
  child.stdout.emit('data', bytes)
  child.stderr.emit('data', bytes)
  expect(stdout).toHaveBeenCalledExactlyOnceWith(bytes)
  expect(stderr).toHaveBeenCalledExactlyOnceWith(bytes)
  expect(managed.stderrTail()).toBe('')
  child.emit('close', 0, null)
  expect(child.stdin.listeners('error')).toEqual([existing])
  expect(child.stdout.listenerCount('error')).toBe(0)
  expect(child.stderr.listenerCount('error')).toBe(0)
})
it('contains raw stdin error even when the caller has no optional error callback', () => {
  const child = createFakePipedChild()
  spawnManagedProviderProcess(
    { command: 'fake-native', args: [] },
    {
      site: 'raw-fixture',
      platform: 'win32',
      spawnImpl: () => child,
      rawOutput: { stdout: () => {}, stderr: () => {} }
    }
  )
  expect(() => child.stdin.emit('error', new Error('synthetic EPIPE'))).not.toThrow()
  child.emit('close', 0, null)
  expect(child.stdin.listenerCount('error')).toBe(0)
})
