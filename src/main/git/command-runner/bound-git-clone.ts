import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ClaimedCloneTarget } from '../repo-clone-path'
import { resolveCommandOnLocalPath } from '../../ipc/command-path-resolver'
import {
  boundGitChildArgs,
  boundGitChildEnvironment,
  boundGitPreflightEnvironment
} from './bound-git-child-command'
import {
  createBoundGitOperationCredential,
  type BoundGitOperationRecord
} from './bound-git-operation-credential'
import type { BoundGitCloneSelection } from './bound-git-clone-selection'

function unavailable(): Error {
  return new Error('Selected Git network profile is unavailable for this clone.')
}

function sameClaimedTarget(
  expected: Pick<Stats, 'dev' | 'ino' | 'birthtimeMs'>,
  current: Stats
): boolean {
  return (
    current.isDirectory() &&
    expected.dev === current.dev &&
    expected.ino === current.ino &&
    expected.birthtimeMs === current.birthtimeMs
  )
}

/** A clone owns no repo row yet; its claimed target and profile generation fence the credential. */
export async function prepareBoundGitClone(input: {
  url: string
  destination: string
  clonePath: string
  claimedTarget: ClaimedCloneTarget
  selection: BoundGitCloneSelection
  signal?: AbortSignal
}): Promise<{
  args: string[]
  env: NodeJS.ProcessEnv
  binding: BoundGitCloneSelection['binding']
  assertCurrent: () => Promise<void>
  close: () => Promise<void>
}> {
  if (
    process.platform === 'win32' ||
    !input.claimedTarget.canCleanup ||
    !input.claimedTarget.ownedDirectoryIdentity ||
    input.signal?.aborted ||
    input.selection.url !== input.url
  ) {
    throw unavailable()
  }
  const { selection } = input
  const launcherPath = selection.launcherPath
  const isolatedHome = await mkdtemp(join(tmpdir(), 'orca-bound-clone-'))
  try {
    const gitBinary = await resolveCommandOnLocalPath('git', {
      cwd: input.destination,
      env: boundGitPreflightEnvironment({
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedHome
      })
    })
    if (!gitBinary) {
      throw unavailable()
    }
    const selectedEnv = {
      ...process.env,
      PATH: `${dirname(gitBinary)}:/usr/bin:/bin`,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: isolatedHome
    }
    const expectedTarget = input.claimedTarget.ownedDirectoryIdentity
    const readCurrentRecord = async (): Promise<BoundGitOperationRecord | null> => {
      if (input.signal?.aborted) {
        return null
      }
      try {
        const current = await selection.readCurrent()
        const stats = await lstat(input.clonePath)
        if (input.signal?.aborted || !current || !sameClaimedTarget(expectedTarget, stats)) {
          return null
        }
        return record
      } catch {
        return null
      }
    }
    const record: BoundGitOperationRecord = {
      operation: 'clone',
      repoId: input.clonePath,
      worktreeId: null,
      worktreePath: input.clonePath,
      commonGitDir: null,
      remoteName: null,
      executionHostId: 'local',
      connectionGeneration: `${expectedTarget.dev}:${expectedTarget.ino}:${expectedTarget.birthtimeMs}`,
      profileId:
        selection.binding.provider === 'gitlab'
          ? selection.binding.id
          : `github\0${selection.binding.host}\0${selection.binding.user}`,
      profileGeneration: selection.binding.generation,
      profileHost: selection.binding.host,
      configFingerprint: createHash('sha256').update(input.url).digest('hex'),
      remoteUrl: input.url,
      username: selection.binding.user,
      deadlineAtMs: Date.now() + 30_000
    }
    if (!(await readCurrentRecord())) {
      throw unavailable()
    }
    const args = boundGitChildArgs(
      ['clone', '--progress', '--', input.url, input.clonePath],
      launcherPath
    )
    const endpoint = await createBoundGitOperationCredential(
      record,
      readCurrentRecord,
      selection.readPassword,
      { signal: input.signal }
    )
    let env: NodeJS.ProcessEnv
    try {
      env = boundGitChildEnvironment(selectedEnv, endpoint.env)
    } catch (error) {
      await endpoint.close()
      throw error
    }
    return {
      args,
      env,
      binding: selection.binding,
      assertCurrent: async () => {
        if (!(await readCurrentRecord())) {
          throw unavailable()
        }
      },
      close: async () => {
        await endpoint.close()
        await rm(isolatedHome, { recursive: true, force: true })
      }
    }
  } catch (error) {
    await rm(isolatedHome, { recursive: true, force: true })
    throw error
  }
}
