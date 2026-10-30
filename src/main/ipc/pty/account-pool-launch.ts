import { bindAccountPoolPtyExecution } from '../../runtime/account-pool-pty-ownership'
import { WORKER_CLAUDE_ACCOUNT_ENV } from '../../claude-accounts/worker-account-launch'
import { applyClaudeEnvPatch, CLAUDE_AUTH_ENV_VARS } from '../../claude-accounts/environment'
import { randomUUID } from 'node:crypto'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { getDefaultAccountPool } from '../../runtime/runtime-account-pool-policy'
import { accountPoolCandidates } from '../../runtime/account-pool-candidates'
import { WORKER_CODEX_ACCOUNT_ENV } from '../../codex-accounts/worker-account-home'
import { preparePinnedClaudeAccountLaunch } from '../../claude-accounts/pinned-account-launch'

export type PtyAccountPoolLaunch = ReturnType<typeof preparePtyAccountPoolLaunch>
export function preparePtyAccountPoolLaunch(args: {
  runtime?: OrcaRuntimeService
  agent?: TuiAgent
  env?: Record<string, string>
  adopted: boolean
  resume: boolean
  connectionId?: string | null
  wsl: boolean
}) {
  const { runtime, agent } = args
  if (
    !runtime ||
    typeof runtime.requireStore !== 'function' ||
    (agent !== 'claude' && agent !== 'codex') ||
    args.adopted ||
    args.resume ||
    args.connectionId ||
    args.wsl ||
    args.env?.[WORKER_CLAUDE_ACCOUNT_ENV] ||
    args.env?.[WORKER_CODEX_ACCOUNT_ENV]
  ) {
    return undefined
  }
  const policy = getDefaultAccountPool(runtime, agent)
  if (!policy || policy.strategy === 'manual') {
    return undefined
  }
  const db = runtime.getOrchestrationDb()
  const assignment = db.acquireAccountPoolAssignment({
    ownerKey: `pty:${randomUUID()}`,
    policy,
    candidates: accountPoolCandidates(runtime.getAccountsSnapshot()).filter(
      (entry) => entry.provider === agent
    )
  })
  let released = false
  const release = () => {
    if (!released) {
      db.releaseAccountPoolAssignment(assignment.ownerKey)
      released = true
    }
  }
  const assertPolicy = (): void => {
    const current = getDefaultAccountPool(runtime, agent)
    const member = current?.members.find((entry) => entry.accountId === assignment.accountId)
    if (
      current?.id !== policy.id ||
      current.revision !== policy.revision ||
      member?.state !== 'enabled'
    ) {
      throw new Error('Account pool changed during launch preparation; retry before starting')
    }
  }
  return {
    assignment,
    release,
    envToDelete: agent === 'claude' ? [...CLAUDE_AUTH_ENV_VARS, 'ANTHROPIC_CUSTOM_HEADERS'] : [],
    async assertReady(): Promise<void> {
      assertPolicy()
      if (agent === 'codex') {
        runtime.getWorkerCodexAccountEnv(assignment.accountId)
      } else {
        await preparePinnedClaudeAccountLaunch({
          accountId: assignment.accountId,
          getAccounts: () => runtime.requireStore().getSettings().claudeManagedAccounts ?? []
        })
      }
      assertPolicy()
    },
    async prepareEnv(): Promise<Record<string, string>> {
      if (agent === 'codex') {
        return { ...args.env, ...runtime.getWorkerCodexAccountEnv(assignment.accountId) }
      }
      const prepared = await preparePinnedClaudeAccountLaunch({
        accountId: assignment.accountId,
        getAccounts: () => runtime.requireStore().getSettings().claudeManagedAccounts ?? []
      })
      return applyClaudeEnvPatch({ ...args.env }, prepared.envPatch, { stripAuthEnv: true })
    },
    bind(ptyId: string, exited: boolean, adopted: boolean, incarnationId?: string): void {
      if (exited || adopted) {
        release()
        return
      }
      bindAccountPoolPtyExecution(runtime, assignment.ownerKey, ptyId, incarnationId, release)
    }
  }
}
