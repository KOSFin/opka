import { useCallback, useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import { sanitizeRepoIcon } from '../../../src/shared/repo-icon'
import { hostRepoCatalogSchema } from '../host-screen/host-screen-reply-schema'
import type { RpcClient } from '../transport/rpc-client'
import { getRetainedRepos, setCachedRepos } from '../cache/repo-cache'
import { listHostRepos } from '../worktree/server-repos'
import { useServerRepos } from '../worktree/use-server-repos'
import { useLastVisitedWorktreeRepoId } from '../worktree/use-last-visited-worktree-repo'
import {
  getMobileNewWorkspaceDialogEligibleRepos,
  refreshMobileNewWorkspaceDialogSelectedRepo,
  resolveMobileNewWorkspaceDialogRepoId
} from '../worktree/new-workspace-dialog-repo-selection'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'

const cachedPickerMetadataSchema = z.object({
  kind: z.enum(['git', 'folder']).optional().catch(undefined),
  upstream: z
    .object({ owner: z.string(), repo: z.string(), host: z.string().optional() })
    .nullable()
    .optional()
    .catch(undefined),
  gitRemoteIdentity: z
    .object({ canonicalKey: z.string(), remoteName: z.string(), remoteUrl: z.string() })
    .nullable()
    .optional()
    .catch(undefined)
})

function readRetainedPickerRepos(hostId: string | undefined): MobileWorkspaceRepo[] | null {
  const retained = hostId ? getRetainedRepos(hostId) : null
  if (!retained) {
    return null
  }
  const parsed = hostRepoCatalogSchema.safeParse({ repos: retained })
  if (!parsed.success) {
    return null
  }
  return parsed.data.flatMap((repo) => {
    if (typeof repo.path !== 'string') {
      return []
    }
    return [
      {
        ...repo,
        ...cachedPickerMetadataSchema.parse(repo),
        path: repo.path,
        executionHostId: normalizeExecutionHostId(repo.executionHostId),
        repoIcon: sanitizeRepoIcon(repo.repoIcon)
      }
    ]
  })
}

const NO_SERVER_CLIENTS: ReadonlyMap<ExecutionHostId, RpcClient> = new Map()

/**
 * The desktop's repos, then each reachable server's as it answers: a slow server never holds back
 * the desktop's own list.
 */
export function useNewWorkspaceRepositories(args: {
  client: RpcClient | null
  /** The desktop's servers this phone can reach now, whose repos are offered too. */
  serverClients?: ReadonlyMap<ExecutionHostId, RpcClient>
  hostId?: string
  visible: boolean
}): {
  repos: MobileWorkspaceRepo[]
  selectedRepo: MobileWorkspaceRepo | null
  setSelectedRepo: (repo: MobileWorkspaceRepo | null) => void
  loading: boolean
} {
  const { client, serverClients = NO_SERVER_CLIENTS, hostId, visible } = args
  const [initialRepos] = useState(() => readRetainedPickerRepos(hostId))
  const [desktopSnapshot, setDesktopSnapshot] = useState({ hostId, repos: initialRepos ?? [] })
  const desktopRepos = desktopSnapshot.hostId === hostId ? desktopSnapshot.repos : []
  const serverRepos = useServerRepos<MobileWorkspaceRepo>(serverClients, visible)
  const [selection, setSelection] = useState<{
    hostId: string | undefined
    repo: MobileWorkspaceRepo | null
  } | null>(null)
  const pickedRepo = selection?.hostId === hostId ? (selection?.repo ?? null) : null
  const setSelectedRepo = useCallback(
    (repo: MobileWorkspaceRepo | null) => {
      setSelection({ hostId, repo })
    },
    [hostId]
  )
  const [loading, setLoading] = useState(initialRepos == null)
  const lastVisitedRepo = useLastVisitedWorktreeRepoId(hostId, visible)
  const repos = useMemo(
    () =>
      serverRepos.size === 0
        ? desktopRepos
        : [...desktopRepos, ...[...serverRepos.values()].flat()],
    [desktopRepos, serverRepos]
  )
  // Why derived: the pick follows its repo's latest listing, and goes once its host stops listing it.
  const selectedRepo = useMemo(
    () => refreshMobileNewWorkspaceDialogSelectedRepo(repos, pickedRepo),
    [pickedRepo, repos]
  )

  useEffect(() => {
    if (!visible || !lastVisitedRepo.loaded || selectedRepo || repos.length === 0) {
      return
    }
    const eligibleRepos = getMobileNewWorkspaceDialogEligibleRepos(repos)
    const preferredRepoId = resolveMobileNewWorkspaceDialogRepoId({
      eligibleRepos,
      activeRepoId: lastVisitedRepo.repoId
    })
    const preferredRepo = repos.find((repo) => repo.id === preferredRepoId) ?? null
    if (preferredRepo) {
      setSelectedRepo(preferredRepo)
    }
  }, [
    lastVisitedRepo.loaded,
    lastVisitedRepo.repoId,
    repos,
    selectedRepo,
    setSelectedRepo,
    visible
  ])

  useEffect(() => {
    if (!visible || !client) {
      return
    }
    let stale = false
    setLoading(true)
    void listHostRepos<MobileWorkspaceRepo>(client)
      .then((listed) => {
        if (stale || !listed) {
          return
        }
        setDesktopSnapshot({ hostId, repos: listed })
        if (hostId) {
          setCachedRepos(hostId, listed)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [visible, client, hostId])

  return { repos, selectedRepo, setSelectedRepo, loading: loading && repos.length === 0 }
}
