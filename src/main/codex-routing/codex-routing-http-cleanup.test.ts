import { expect, it, vi } from 'vitest'
import { finishCodexRoutingRequest } from './codex-routing-http-cleanup'

const engineKey = 'synthetic-replay-engine-1234567890123456'

it.each(['throwing', 'rejected'] as const)(
  'fails closed when the session ownership hold is %s',
  async (failure) => {
    const cleanup = vi.fn()
    const finish = vi.fn()
    await finishCodexRoutingRequest(
      {
        maxConcurrent: 1,
        maxRequestBytes: 4096,
        maxResponseBytes: 4096,
        responseHeaderTimeoutMs: 1000,
        onCleanupUnverifiable: cleanup,
        prepare: () => {
          throw new Error('Not used')
        }
      },
      {
        port: 1,
        clientKey: engineKey,
        prefix: 'a',
        finish,
        holdUntilOwnerExit: () => {
          if (failure === 'throwing') {
            throw new Error('Synthetic hold unavailable')
          }
          return Promise.reject(new Error('Synthetic owner unverifiable'))
        }
      },
      undefined,
      true,
      false
    )
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce())
    expect(finish).not.toHaveBeenCalled()
  }
)

it('fails closed when releasing the held lease after owner exit fails', async () => {
  const cleanup = vi.fn()
  const finish = vi.fn(() => {
    throw new Error('Synthetic lease release failed')
  })
  await finishCodexRoutingRequest(
    {
      maxConcurrent: 1,
      maxRequestBytes: 4096,
      maxResponseBytes: 4096,
      responseHeaderTimeoutMs: 1000,
      onCleanupUnverifiable: cleanup,
      prepare: () => {
        throw new Error('Not used')
      }
    },
    {
      port: 1,
      clientKey: engineKey,
      prefix: 'a',
      finish,
      holdUntilOwnerExit: async () => {}
    },
    undefined,
    true,
    false
  )
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce())
  expect(finish).toHaveBeenCalledOnce()
})
