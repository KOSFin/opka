import type { WorkerStartInput } from './worker-start-schema'
import type { WorkerStartModeReceipt } from '../../orchestration-worker-start-mode'
import type { OrchestrationWorkerLaunchReceipt } from './worker-launch-preferences'
import { workerSetupSource } from './worker-worktree-creation'

export function workerStartOptions(args: {
  params: WorkerStartInput
  mode: WorkerStartModeReceipt
  requestedWorktree: string
  resolvedWorktreeId?: string
  creationRepoId?: string
  agent?: string
  launch: OrchestrationWorkerLaunchReceipt
  createsWorktree: boolean
}) {
  const { params } = args
  return {
    ...(params.accountId ? { account: { provider: params.agent, id: params.accountId } } : {}),
    worktree: args.requestedWorktree,
    mode: args.mode,
    resolvedWorktreeId: args.resolvedWorktreeId ?? null,
    name: params.name ?? null,
    repo: params.repo ?? args.creationRepoId ?? null,
    baseBranch: params.baseBranch ?? null,
    terminal: params.terminal ?? null,
    agent: args.agent ?? null,
    launch: args.launch,
    timeoutMs: params.timeoutMs ?? 60_000,
    setup: args.createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
    setupSource: workerSetupSource(args.createsWorktree, params.setup)
  }
}
