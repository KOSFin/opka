import { expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { spawnManagedProviderProcess } from './managed-provider-process'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from './provider-process-supervisor'

function fixture(platform: NodeJS.Platform = 'linux') {
  const child = createFakePipedChild()
  const managed = spawnManagedProviderProcess(
    { command: '/synthetic/provider', args: [] },
    {
      site: 'no-provider-proof',
      platform,
      spawnImpl: () => child,
      policy: () => ({ gracefulExitMs: PROVIDER_SUPERVISOR_MAX_STOP_MS, forcedExitMs: 1 })
    }
  )
  return { child, managed }
}
it('requires both a private no-start message and the supervisor exit', () => {
  const { child, managed } = fixture()
  child.emit('message', { providerNotStarted: true })
  expect(managed.providerNotStarted).toBe(false)
  child.emit('exit', 127, null)
  expect(managed.providerNotStarted).toBe(true)
})
it.each(['stderr-only', 'extra-fields', 'group-reported', 'unsupervised'])(
  'does not accept %s as no-provider proof',
  (scenario) => {
    const { child, managed } = fixture(scenario === 'unsupervised' ? 'win32' : 'linux')
    if (scenario === 'stderr-only') {
      child.stderr.write('{"providerNotStarted":true}')
    } else if (scenario === 'extra-fields') {
      child.emit('message', { providerNotStarted: true, unexpected: true })
    } else {
      if (scenario === 'group-reported') {
        child.emit('message', { pgid: 123456789 })
      }
      child.emit('message', { providerNotStarted: true })
    }
    child.emit('exit', 127, null)
    expect(managed.providerNotStarted).toBe(false)
  }
)
it('accepts a direct processless failure only after error and close', () => {
  const child = createFakePipedChild()
  Object.defineProperty(child, 'pid', { value: undefined })
  const managed = spawnManagedProviderProcess(
    { command: '/synthetic/missing', args: [] },
    {
      site: 'direct-no-provider-proof',
      platform: 'win32',
      spawnImpl: vi.fn(() => child)
    }
  )
  child.emit('error', Object.assign(new Error('synthetic ENOENT'), { code: 'ENOENT' }))
  expect(managed.providerNotStarted).toBe(false)
  child.emit('close', -2, null)
  expect(managed.providerNotStarted).toBe(true)
})
