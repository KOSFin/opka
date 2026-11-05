import { expect, it, vi } from 'vitest'
import { retryCodexQuotaBeforeDeadline } from './codex-quota-retry-deadline'
const quota = { kind: 'quota', code: 'usage_limit_reached' } as const
it('forwards a finite quota response when a host callback never settles and aborts its evidence work', async () => {
  let observed: AbortSignal | undefined
  const retry = vi.fn((_failure: unknown, context: { signal?: AbortSignal }) => {
    observed = context.signal
    return new Promise<null>(() => {})
  })
  const route = {
    port: 1234,
    clientKey: 'synthetic-engine-key',
    prefix: 'synthetic-A',
    finish: vi.fn(),
    retryRejectedQuota: retry
  }
  expect(
    await retryCodexQuotaBeforeDeadline(route, quota, true, new AbortController().signal, 10)
  ).toBeNull()
  expect(observed?.aborted).toBe(true)
  expect(retry).toHaveBeenCalledOnce()
})
