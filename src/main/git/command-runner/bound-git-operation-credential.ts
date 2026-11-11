import { createBoundGitCredentialEndpoint } from './bound-git-credential-endpoint'
import {
  matchesBoundGitCredentialTarget,
  parseBoundGitCredentialTarget
} from './bound-git-credential-target'

export type BoundGitOperationRecord = {
  operation: 'clone' | 'fetch' | 'pull' | 'push'
  repoId: string
  worktreeId: string | null
  worktreePath: string | null
  commonGitDir: string | null
  remoteName: string | null
  executionHostId: string
  connectionGeneration: string
  profileId: string
  profileGeneration: string
  profileHost: string
  configFingerprint: string
  remoteUrl: string
  username: string
  deadlineAtMs: number
}

export type BoundGitOwnerIdentity = Omit<
  BoundGitOperationRecord,
  'configFingerprint' | 'remoteUrl' | 'deadlineAtMs'
>

const OWNER_KEYS: readonly (keyof BoundGitOwnerIdentity)[] = [
  'operation',
  'repoId',
  'worktreeId',
  'worktreePath',
  'commonGitDir',
  'remoteName',
  'executionHostId',
  'connectionGeneration',
  'profileId',
  'profileGeneration',
  'profileHost',
  'username'
]

export function sameBoundGitOwnerIdentity(
  expected: BoundGitOwnerIdentity,
  current: BoundGitOwnerIdentity | null
): boolean {
  return current !== null && OWNER_KEYS.every((key) => current[key] === expected[key])
}

const RECORD_KEYS: readonly (keyof BoundGitOperationRecord)[] = [
  'operation',
  'repoId',
  'worktreeId',
  'worktreePath',
  'commonGitDir',
  'remoteName',
  'executionHostId',
  'connectionGeneration',
  'profileId',
  'profileGeneration',
  'profileHost',
  'configFingerprint',
  'remoteUrl',
  'username',
  'deadlineAtMs'
]

export function sameBoundGitOperationRecord(
  expected: BoundGitOperationRecord,
  current: BoundGitOperationRecord | null
): boolean {
  return current !== null && RECORD_KEYS.every((key) => current[key] === expected[key])
}

export async function createBoundGitOperationCredential(
  record: BoundGitOperationRecord,
  readCurrentRecord: () => Promise<BoundGitOperationRecord | null>,
  readPassword: () => Promise<string>,
  options: { signal?: AbortSignal }
) {
  const expected = { ...record }
  const target = parseBoundGitCredentialTarget(expected.remoteUrl, expected.username)
  const targetHost = target.port === '443' ? target.host : `${target.host}:${target.port}`
  if (targetHost !== expected.profileHost) {
    throw new Error('Bound Git profile host does not match the remote.')
  }
  const remainingMs = expected.deadlineAtMs - Date.now()
  if (!Number.isSafeInteger(expected.deadlineAtMs) || remainingMs < 1 || remainingMs > 30_000) {
    throw new Error('Bound Git operation expired.')
  }
  return createBoundGitCredentialEndpoint(
    async (request, signal) => {
      if (
        signal.aborted ||
        Date.now() >= expected.deadlineAtMs ||
        !matchesBoundGitCredentialTarget(target, request)
      ) {
        return null
      }
      const current = await readCurrentRecord()
      if (
        signal.aborted ||
        Date.now() >= expected.deadlineAtMs ||
        !sameBoundGitOperationRecord(expected, current)
      ) {
        return null
      }
      const password = await readPassword()
      const finalRecord = await readCurrentRecord()
      if (
        signal.aborted ||
        Date.now() >= expected.deadlineAtMs ||
        !sameBoundGitOperationRecord(expected, finalRecord) ||
        !password ||
        /[\r\n\0]/.test(password)
      ) {
        return null
      }
      return { username: target.username, password }
    },
    { deadlineMs: remainingMs, signal: options.signal }
  )
}
