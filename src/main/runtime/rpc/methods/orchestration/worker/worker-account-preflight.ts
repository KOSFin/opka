import { preparePinnedClaudeAccountLaunch } from '../../../../../claude-accounts/pinned-account-launch'
import { WORKER_CLAUDE_ACCOUNT_ENV } from '../../../../../claude-accounts/worker-account-launch'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { parseWslPath } from '../../../../../wsl'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { WorkerStartInput } from './worker-start-schema'
import type { WorkerStartModeReceipt } from '../../orchestration-worker-start-mode'

export async function prepareWorkerAccountEnv(
  runtime: OrcaRuntimeService,
  params: WorkerStartInput,
  mode: WorkerStartModeReceipt,
  target: Pick<Worktree, 'id' | 'repoId'> | undefined
): Promise<Record<string, string> | undefined> {
  if (!params.accountId) {
    return undefined
  }
  const repo = params.repo
    ? await runtime.showRepo(params.repo)
    : runtime.listRepos().find((entry) => entry.id === target?.repoId)
  if (
    (params.agent !== 'codex' && params.agent !== 'claude') ||
    params.terminal ||
    params.on ||
    mode.mode !== 'terminal' ||
    !target ||
    (repo && getRepoExecutionHostId(repo) !== 'local') ||
    (repo && parseWslPath(repo.path))
  ) {
    throw new Error(
      'Explicit worker accounts currently require a new local host Claude or Codex terminal, not a structured, SSH or WSL session'
    )
  }
  const resolved = await runtime.resolveRuntimeFileTarget(`id:${target.id}`)
  if (resolved.executionHostId !== 'local' || parseWslPath(resolved.worktree.path)) {
    throw new Error('Explicit worker accounts require a local host workspace')
  }
  if (params.agent === 'claude') {
    await preparePinnedClaudeAccountLaunch({
      accountId: params.accountId,
      getAccounts: () => runtime.requireStore().getSettings().claudeManagedAccounts ?? []
    })
    return { [WORKER_CLAUDE_ACCOUNT_ENV]: params.accountId }
  }
  return runtime.getWorkerCodexAccountEnv(params.accountId)
}
