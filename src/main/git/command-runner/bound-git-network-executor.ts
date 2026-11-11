import { constants } from 'node:fs'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { withGitSpan } from '../../observability/instrumentation'
import { resolveCommandOnLocalPath } from '../../ipc/command-path-resolver'
import {
  resolveGitFetchHeadCommand,
  runWithGitFetchHeadLock
} from '../../../shared/git-fetch-head-lock'
import { runWithGitOperationLock } from '../../../shared/git-operation-lock'
import { runWithGitWorktreeOperationLock } from '../../../shared/git-worktree-operation-lock'
import { acquireGitAdmission } from './git-subprocess-admission'
import { createAbortError } from './abort-error'
import { execFileCaptureToTermination } from './exec-file-capture'
import {
  boundGitChildArgs,
  boundGitChildEnvironment,
  boundGitPreflightEnvironment
} from './bound-git-child-command'
import { readBoundGitEffectiveRemote } from './bound-git-effective-remote'
import {
  createBoundGitOperationCredential,
  sameBoundGitOwnerIdentity,
  sameBoundGitOperationRecord,
  type BoundGitOperationRecord,
  type BoundGitOwnerIdentity
} from './bound-git-operation-credential'
import type { GitExecOptions } from './git-exec-options'
import { gitCommandTimeoutMs } from './git-command-timeout'

const MAX_PREFLIGHT_OUTPUT_BYTES = 1024 * 1024
const PREFLIGHT_TIMEOUT_MS = 2000

export type BoundGitExecution = {
  identity: BoundGitOwnerIdentity
  launcherPath: string
  readCurrentIdentity: () => Promise<BoundGitOwnerIdentity | null>
  readPassword: () => Promise<string>
}

function boundUnavailable(): Error {
  return new Error('Bound Git operation unavailable.')
}

function commandTargetsRemote(
  args: readonly string[],
  operation: string,
  remoteName: string
): boolean {
  if (operation === 'fetch') {
    return (
      args.length === 3 && args[0] === 'fetch' && args[1] === '--prune' && args[2] === remoteName
    )
  }
  if (operation === 'pull') {
    const flags = args.slice(1, -2)
    return (
      args[0] === 'pull' &&
      args.length >= 3 &&
      args.at(-2) === remoteName &&
      Boolean(args.at(-1)) &&
      !args.at(-1)?.startsWith('-') &&
      flags.every((flag) => ['--ff-only', '--no-rebase'].includes(flag))
    )
  }
  if (operation === 'push') {
    const flags = args.slice(1, -2)
    return (
      args[0] === 'push' &&
      args.at(-2) === remoteName &&
      (args.at(-1) === 'HEAD' || /^HEAD:[^\s:]+$/.test(args.at(-1) ?? '')) &&
      flags.includes('--set-upstream') &&
      flags.every((flag) => ['--set-upstream', '--force-with-lease'].includes(flag))
    )
  }
  return false
}

export async function runBoundGitNetworkCommand(
  args: string[],
  options: GitExecOptions,
  bound: BoundGitExecution
): Promise<{ stdout: string; stderr: string }> {
  const owner = { ...bound.identity }
  const commonGitDir = owner.commonGitDir
  const remoteName = owner.remoteName
  const operation = owner.operation
  if (
    process.platform === 'win32' ||
    options.wslDistro ||
    options.preferWslDirectGit ||
    options.useConfiguredSshCommandForNetwork ||
    options.captureWslLoginShellOutput ||
    options.admissionExempt ||
    options.onStderr ||
    options.stdin !== undefined ||
    !owner.worktreePath ||
    options.cwd !== owner.worktreePath ||
    !commonGitDir ||
    !remoteName ||
    operation === 'clone' ||
    !commandTargetsRemote(args, operation, remoteName)
  ) {
    throw boundUnavailable()
  }
  return withGitSpan({ args, cwd: options.cwd }, async (span) => {
    try {
      return await runWithGitOperationLock(commonGitDir, options.signal, async () => {
        const fetchHead = resolveGitFetchHeadCommand(args, options.cwd)
        const run = async (): Promise<{ stdout: string; stderr: string }> => {
          const grant = await acquireGitAdmission({
            args,
            cwd: options.cwd,
            tier: options.admissionTier,
            signal: options.admissionSignal ?? options.signal
          })
          span?.setAttribute('git.queue_wait_ms', grant.queueWaitMs)
          try {
            if (options.signal?.aborted || options.canStart?.() === false) {
              throw createAbortError()
            }
            const inheritedEnv = options.env ?? process.env
            const gitBinary = await resolveCommandOnLocalPath('git', {
              env: inheritedEnv,
              cwd: options.cwd
            })
            if (!gitBinary) {
              throw boundUnavailable()
            }
            const isolatedHome = await mkdtemp(join(tmpdir(), 'orca-bound-git-'))
            try {
              const selectedEnv = {
                ...inheritedEnv,
                PATH: `${dirname(gitBinary)}:/usr/bin:/bin`,
                HOME: isolatedHome,
                XDG_CONFIG_HOME: isolatedHome
              }
              const preflightEnv = boundGitPreflightEnvironment(selectedEnv)
              const readLocalGit = async (localArgs: readonly string[]): Promise<Buffer> => {
                try {
                  const output = await execFileCaptureToTermination(gitBinary, [...localArgs], {
                    cwd: options.cwd,
                    env: preflightEnv,
                    encoding: 'buffer',
                    maxBuffer: MAX_PREFLIGHT_OUTPUT_BYTES,
                    timeout: PREFLIGHT_TIMEOUT_MS,
                    signal: options.signal
                  })
                  if (!Buffer.isBuffer(output.stdout)) {
                    throw boundUnavailable()
                  }
                  return output.stdout
                } catch {
                  throw boundUnavailable()
                }
              }
              const currentOwner = await bound.readCurrentIdentity()
              if (!sameBoundGitOwnerIdentity(owner, currentOwner)) {
                throw boundUnavailable()
              }
              const initialSnapshot = await readBoundGitEffectiveRemote(
                operation,
                remoteName,
                owner.username,
                readLocalGit
              )
              if (new URL(initialSnapshot.remoteUrl).host !== owner.profileHost) {
                throw boundUnavailable()
              }
              const expected: BoundGitOperationRecord = {
                ...owner,
                ...initialSnapshot,
                deadlineAtMs: Date.now() + 30_000
              }
              const readCurrent = async (): Promise<BoundGitOperationRecord | null> => {
                try {
                  const current = await bound.readCurrentIdentity()
                  if (!current || !sameBoundGitOwnerIdentity(owner, current)) {
                    return null
                  }
                  const snapshot = await readBoundGitEffectiveRemote(
                    operation,
                    remoteName,
                    owner.username,
                    readLocalGit
                  )
                  return { ...current, ...snapshot, deadlineAtMs: expected.deadlineAtMs }
                } catch {
                  return null
                }
              }
              if (!sameBoundGitOperationRecord(expected, await readCurrent())) {
                throw boundUnavailable()
              }
              await access(bound.launcherPath, constants.X_OK).catch(() => {
                throw boundUnavailable()
              })
              const commandArgs = boundGitChildArgs(args, bound.launcherPath)
              const endpoint = await createBoundGitOperationCredential(
                expected,
                readCurrent,
                bound.readPassword,
                { signal: options.signal }
              )
              try {
                await execFileCaptureToTermination(gitBinary, commandArgs, {
                  cwd: options.cwd,
                  env: boundGitChildEnvironment(selectedEnv, endpoint.env),
                  encoding: 'utf-8',
                  maxBuffer: options.maxBuffer,
                  timeout: gitCommandTimeoutMs(args, options.timeout, options.timeoutMsForTest),
                  signal: options.signal,
                  terminationBarrier: true
                })
                return { stdout: '', stderr: '' }
              } finally {
                await endpoint.close()
              }
            } finally {
              await rm(isolatedHome, { recursive: true, force: true })
            }
          } finally {
            grant.release()
          }
        }
        const runWithFetchHeadLock = (): Promise<{ stdout: string; stderr: string }> =>
          fetchHead.needsLock
            ? runWithGitFetchHeadLock(fetchHead.cwd, options.signal, run, fetchHead.gitDir)
            : run()
        return operation === 'pull'
          ? runWithGitWorktreeOperationLock(options.cwd, options.signal, runWithFetchHeadLock)
          : runWithFetchHeadLock()
      })
    } catch {
      if (options.signal?.aborted) {
        throw createAbortError()
      }
      throw boundUnavailable()
    }
  })
}
