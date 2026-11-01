import { afterEach, expect, it, vi } from 'vitest'
import { readSkillOwnerComputerPermissions } from './skill-owner-computer-permissions'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})
const result = {
  platform: 'linux' as const,
  helperAppPath: null,
  helperUnavailableReason: 'unsupported_platform',
  permissions: []
}

it('checks local app access only for local skill ownership', async () => {
  const getStatus = vi.fn().mockResolvedValue(result)
  vi.stubGlobal('window', { api: { computerUsePermissions: { getStatus } } })
  expect(await readSkillOwnerComputerPermissions({ kind: 'local' })).toEqual(result)
  expect(getStatus).toHaveBeenCalledOnce()
  expect(callRuntimeRpc).not.toHaveBeenCalled()
})

it('asks the skill owner instead of checking viewer macOS permissions', async () => {
  const getStatus = vi.fn()
  vi.stubGlobal('window', { api: { computerUsePermissions: { getStatus } } })
  vi.mocked(callRuntimeRpc).mockResolvedValue(result)
  const target = { kind: 'environment', environmentId: 'new-host' } as const
  expect(await readSkillOwnerComputerPermissions(target)).toEqual(result)
  expect(callRuntimeRpc).toHaveBeenCalledWith(target, 'computer.permissionsStatus')
  expect(getStatus).not.toHaveBeenCalled()
})

it('keeps remote failure unverifiable without a local permission fallback', async () => {
  const getStatus = vi.fn().mockResolvedValue(result)
  vi.stubGlobal('window', { api: { computerUsePermissions: { getStatus } } })
  vi.mocked(callRuntimeRpc).mockRejectedValue(new Error('owner disconnected'))
  await expect(
    readSkillOwnerComputerPermissions({ kind: 'environment', environmentId: 'new-host' })
  ).rejects.toThrow('owner disconnected')
  expect(getStatus).not.toHaveBeenCalled()
})
