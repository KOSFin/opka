import type { GitAdmissionTier } from './command-runner/git-exec-options'
import type { BoundGitExecution } from './command-runner/bound-git-network-executor'

export type GitRuntimeOptions = {
  wslDistro?: string
  signal?: AbortSignal
  admissionTier?: GitAdmissionTier
  boundOperation?: BoundGitExecution
}

export function gitNetworkOptionsForWorktree(
  cwd: string,
  options: GitRuntimeOptions = {}
): ReturnType<typeof gitOptionsForWorktree> & { boundOperation?: BoundGitExecution } {
  return {
    ...gitOptionsForWorktree(cwd, options),
    ...(options.boundOperation ? { boundOperation: options.boundOperation } : {})
  }
}

export function gitOptionsForWorktree(
  cwd: string,
  options: GitRuntimeOptions = {}
): { cwd: string; wslDistro?: string; signal?: AbortSignal; admissionTier?: GitAdmissionTier } {
  return {
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
  }
}

/**
 * Options for a git invocation that only reads. Opting in explicitly keeps the
 * shell-free WSL route from depending on `wsl-direct-git-read-commands`
 * classifying the argv, which is a heuristic these call sites already know the
 * answer to.
 */
export function gitReadOptionsForWorktree(
  cwd: string,
  options: GitRuntimeOptions = {}
): {
  cwd: string
  wslDistro?: string
  signal?: AbortSignal
  admissionTier?: GitAdmissionTier
  preferWslDirectGit: true
} {
  return { ...gitOptionsForWorktree(cwd, options), preferWslDirectGit: true }
}
