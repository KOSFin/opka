import { afterEach, expect, it, vi } from 'vitest'
import { readUsageAccountPools, peekUsageAccountPools } from './usage-account-pool-cache'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
const view = {
  capability: 'orchestration.account-pools.v1',
  policies: [],
  accounts: {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null }
  },
  candidates: [],
  assignments: []
}
afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})
it('deduplicates reads and retains a bounded current-owner cache', async () => {
  rpc.mockResolvedValue(view)
  const a = { kind: 'environment', environmentId: 'cache-a' } as const
  expect(readUsageAccountPools(a)).toBe(readUsageAccountPools(a))
  await readUsageAccountPools(a)
  await readUsageAccountPools(a)
  expect(rpc).toHaveBeenCalledTimes(1)
  for (let index = 0; index < 9; index++) {
    await readUsageAccountPools({ kind: 'environment', environmentId: `bounded-${index}` })
  }
  expect(peekUsageAccountPools(a)).toBeNull()
})
it('retains last-known metadata on failure and retries expired entries', async () => {
  vi.useFakeTimers()
  rpc
    .mockResolvedValueOnce(view)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(view)
  const b = { kind: 'environment', environmentId: 'cache-b' } as const
  const saved = await readUsageAccountPools(b)
  vi.advanceTimersByTime(31_000)
  await expect(readUsageAccountPools(b)).rejects.toThrow('offline')
  expect(peekUsageAccountPools(b)).toEqual(saved)
  await readUsageAccountPools(b)
  expect(rpc).toHaveBeenCalledTimes(3)
})
