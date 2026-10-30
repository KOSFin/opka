import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { prepareWorkerClaudeLaunchEnv, WORKER_CLAUDE_ACCOUNT_ENV } from './worker-account-launch'
const pinned = vi.hoisted(() =>
  vi.fn(async () => ({
    envPatch: {
      CLAUDE_CONFIG_DIR: '/synthetic/pinned',
      ORCA_CLAUDE_PROFILE_POINTER: '/synthetic/pointer'
    }
  }))
)
vi.mock('./pinned-account-launch', () => ({ preparePinnedClaudeAccountLaunch: pinned }))
function runtime() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mocked pinned preparation only receives this runtime through a lazy getAccounts callback.
  return {
    requireStore: () => ({ getSettings: () => ({ claudeManagedAccounts: [] }) })
  } as unknown as OrcaRuntimeService
}
it('pins explicit Claude worker identity and strips transport marker and auth overrides', async () => {
  const result = await prepareWorkerClaudeLaunchEnv(
    {
      [WORKER_CLAUDE_ACCOUNT_ENV]: 'account',
      ANTHROPIC_API_KEY: 'synthetic',
      CLAUDE_CONFIG_DIR: '/synthetic/global',
      KEEP: 'yes'
    },
    runtime(),
    false
  )
  expect(result).toMatchObject({ CLAUDE_CONFIG_DIR: '/synthetic/pinned', KEEP: 'yes' })
  expect(result?.ANTHROPIC_API_KEY).toBeUndefined()
  expect(result?.[WORKER_CLAUDE_ACCOUNT_ENV]).toBeUndefined()
  expect(pinned).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account' }))
})
it('refuses unowned or WSL explicit account routing', async () => {
  const env = { [WORKER_CLAUDE_ACCOUNT_ENV]: 'account' }
  await expect(prepareWorkerClaudeLaunchEnv(env, undefined, false)).rejects.toThrow(/owning native/)
  await expect(prepareWorkerClaudeLaunchEnv(env, runtime(), true)).rejects.toThrow(/owning native/)
})
