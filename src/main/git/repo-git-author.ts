import type { Repo } from '../../shared/repo-types'
import type {
  RepoGitAuthor,
  RepoGitAuthorField,
  RepoGitAuthorUpdate
} from '../../shared/repo-git-author'
import { isFolderRepo } from '../../shared/repo-kind'
import { runWithGitOperationLock } from '../../shared/git-operation-lock'
import path from 'node:path'
import { isWslPath } from '../wsl'
import { gitExecFileAsync } from './runner'

type AuthorRepo = Pick<Repo, 'id' | 'path' | 'kind'>
type ConfigEntry = { value: string; source: string }

function isMissingConfig(error: unknown, forUnset = false): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 1 || (forUnset && error.code === 5))
  )
}

async function configEntry(
  repoPath: string,
  key: string,
  local: boolean
): Promise<ConfigEntry | null> {
  try {
    const args = ['config', ...(local ? ['--local'] : []), '--show-origin', '--get', key]
    const { stdout } = await gitExecFileAsync(args, { cwd: repoPath, timeout: 5000 })
    const output = stdout.replace(/\r?\n$/, '')
    const separator = output.indexOf('\t')
    if (separator === -1) {
      throw new Error('Git did not report the author config origin.')
    }
    return { source: output.slice(0, separator), value: output.slice(separator + 1) }
  } catch (error) {
    if (isMissingConfig(error)) {
      return null
    }
    throw error
  }
}

async function authorField(repoPath: string, key: string): Promise<RepoGitAuthorField> {
  const [effective, local] = await Promise.all([
    configEntry(repoPath, key, false),
    configEntry(repoPath, key, true)
  ])
  return {
    effective: effective?.value ?? null,
    local: local?.value ?? null,
    origin: !effective ? 'unset' : local?.source === effective.source ? 'local' : 'inherited'
  }
}

async function assertRepoGitRoot(repo: AuthorRepo): Promise<void> {
  if (isFolderRepo(repo)) {
    throw new Error('Git author is unavailable for a folder project.')
  }
  if (isWslPath(repo.path)) {
    throw new Error('Git author settings for WSL projects require a WSL-owned author route.')
  }
  const { stdout: inside } = await gitExecFileAsync(['rev-parse', '--is-inside-work-tree'], {
    cwd: repo.path,
    timeout: 5000
  })
  const { stdout: cdup } = await gitExecFileAsync(['rev-parse', '--show-cdup'], {
    cwd: repo.path,
    timeout: 5000
  })
  if (inside.trim() !== 'true' || cdup.split(/\r?\n/)[0] !== '') {
    throw new Error('Repository path is not the root of its Git worktree.')
  }
}

async function authorConfigLockKey(repo: AuthorRepo): Promise<string> {
  await assertRepoGitRoot(repo)
  const { stdout } = await gitExecFileAsync(['rev-parse', '--git-common-dir'], {
    cwd: repo.path,
    timeout: 5000
  })
  return `repo-git-author:${path.resolve(repo.path, stdout.trim())}`
}

async function readVerifiedAuthor(repo: AuthorRepo): Promise<RepoGitAuthor> {
  await assertRepoGitRoot(repo)
  const [name, email] = await Promise.all([
    authorField(repo.path, 'user.name'),
    authorField(repo.path, 'user.email')
  ])
  return { name, email }
}

function validateAuthorValue(value: string | null): void {
  if (value === null) {
    return
  }
  if (value.length === 0 || value.length > 320 || /[\r\n\0]/.test(value)) {
    throw new Error('Git author value must be nonempty, at most 320 characters, and one line.')
  }
}

async function writeLocal(repoPath: string, key: string, value: string | null): Promise<void> {
  if (value === null) {
    try {
      await gitExecFileAsync(['config', '--local', '--unset-all', key], {
        cwd: repoPath,
        timeout: 5000
      })
    } catch (error) {
      if (!isMissingConfig(error, true)) {
        throw error
      }
    }
    return
  }
  await gitExecFileAsync(['config', '--local', '--replace-all', key, value], {
    cwd: repoPath,
    timeout: 5000
  })
}

export async function readRepoGitAuthor(repo: AuthorRepo): Promise<RepoGitAuthor> {
  return runWithGitOperationLock(await authorConfigLockKey(repo), undefined, () =>
    readVerifiedAuthor(repo)
  )
}

export async function updateRepoGitAuthor(
  repo: AuthorRepo,
  update: RepoGitAuthorUpdate
): Promise<RepoGitAuthor> {
  validateAuthorValue(update.name)
  validateAuthorValue(update.email)
  return runWithGitOperationLock(await authorConfigLockKey(repo), undefined, async () => {
    const before = await readVerifiedAuthor(repo)
    if (
      before.name.local !== update.expectedLocalName ||
      before.email.local !== update.expectedLocalEmail
    ) {
      throw new Error('Git author settings changed on this host. Refresh before saving.')
    }
    try {
      await writeLocal(repo.path, 'user.name', update.name)
      await writeLocal(repo.path, 'user.email', update.email)
      const after = await readVerifiedAuthor(repo)
      if (after.name.local !== update.name || after.email.local !== update.email) {
        throw new Error('Git author readback did not match the requested local values.')
      }
      return after
    } catch {
      let restored = false
      try {
        await writeLocal(repo.path, 'user.name', before.name.local)
        await writeLocal(repo.path, 'user.email', before.email.local)
        const readback = await readVerifiedAuthor(repo)
        restored =
          readback.name.local === before.name.local && readback.email.local === before.email.local
      } catch {
        // A failed rollback leaves the readback below as the only authoritative state.
      }
      if (restored) {
        throw new Error('Could not save Git author settings; previous local values were restored.')
      }
      throw new Error('Could not save Git author settings; local values may have changed. Refresh.')
    }
  })
}
