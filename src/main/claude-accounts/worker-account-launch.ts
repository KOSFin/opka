import { applyClaudeEnvPatch, CLAUDE_AUTH_ENV_VARS } from './environment'
import { preparePinnedClaudeAccountLaunch } from './pinned-account-launch'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
export const WORKER_CLAUDE_ACCOUNT_ENV = 'ORCA_WORKER_CLAUDE_ACCOUNT_ID'
export const PINNED_CLAUDE_AUTH_DELETIONS = [
  ...CLAUDE_AUTH_ENV_VARS,
  'ANTHROPIC_CUSTOM_HEADERS',
  WORKER_CLAUDE_ACCOUNT_ENV
]
export async function prepareWorkerClaudeLaunchEnv(
  env: Record<string, string> | undefined,
  runtime: OrcaRuntimeService | undefined,
  wsl: boolean
): Promise<Record<string, string> | undefined> {
  const accountId = env?.[WORKER_CLAUDE_ACCOUNT_ENV]
  if (!accountId) {
    return undefined
  }
  if (!runtime || wsl) {
    throw new Error('A pinned Claude account requires its owning native execution host')
  }
  const prepared = await preparePinnedClaudeAccountLaunch({
    accountId,
    getAccounts: () => runtime.requireStore().getSettings().claudeManagedAccounts ?? []
  })
  const result = applyClaudeEnvPatch({ ...env }, prepared.envPatch, { stripAuthEnv: true })
  delete result[WORKER_CLAUDE_ACCOUNT_ENV]
  return result
}
