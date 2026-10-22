import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitHistory } from '@/runtime/runtime-git-status-client'
import { useAppStore } from '@/store'
import type { GitHistoryPanelState } from './git-history-panel'
import {
  forgetGitHistorySnapshot,
  readGitHistorySnapshot,
  loadGitHistorySnapshot,
  GIT_HISTORY_SNAPSHOT_FRESH_MS
} from './git-history-snapshots'

const EMPTY_GIT_HISTORY_STATE: GitHistoryPanelState = { status: 'idle' }

export function useSourceControlGitHistory({
  viewKey,
  activeRepoTarget,
  activeWorktreeId,
  worktreePath,
  compareBaseRef,
  isFolder,
  isBranchVisible,
  isGitHistoryExpanded,
  isGitHistoryVisible,
  worktreeMap
}: {
  viewKey?: string | null
  activeRepoTarget: RuntimeClientTarget | null
  activeWorktreeId: string | null
  worktreePath: string | null
  compareBaseRef: string | null
  isFolder: boolean
  isBranchVisible: boolean
  isGitHistoryExpanded: boolean
  isGitHistoryVisible: boolean
  worktreeMap: ReadonlyMap<string, unknown>
}): {
  gitHistoryState: GitHistoryPanelState
  refreshGitHistory: () => Promise<void>
  refreshGitHistoryRef: RefObject<() => Promise<void>>
} {
  const head = useAppStore((s) =>
    activeWorktreeId ? s.gitStatusHeadByWorktree?.[activeWorktreeId] : undefined
  )
  const owner = JSON.stringify([
    viewKey,
    activeRepoTarget,
    activeWorktreeId,
    worktreePath,
    getConnectionId(activeWorktreeId ?? ''),
    compareBaseRef
  ])
  const key = JSON.stringify([owner, head ?? null])
  const requestGeneration = useRef(0)
  const [state, setState] = useState<{ key: string; owner: string; value: GitHistoryPanelState }>({
    key,
    owner,
    value: EMPTY_GIT_HISTORY_STATE
  })
  const snapshot = readGitHistorySnapshot(key)
  const retained = state.owner === owner ? state.value.result : undefined
  const fallback: GitHistoryPanelState = snapshot
    ? { status: 'ready', result: snapshot.result }
    : retained
      ? { status: 'refreshing', result: retained }
      : EMPTY_GIT_HISTORY_STATE
  const gitHistoryState =
    activeWorktreeId && !worktreeMap.has(activeWorktreeId)
      ? EMPTY_GIT_HISTORY_STATE
      : state.key === key && (state.value.result || state.value.status !== 'idle')
        ? state.value
        : fallback
  const refreshGitHistory = useCallback(async () => {
    if (
      !activeWorktreeId ||
      !worktreeMap.has(activeWorktreeId) ||
      !worktreePath ||
      isFolder ||
      !isBranchVisible ||
      !isGitHistoryExpanded ||
      !isGitHistoryVisible
    ) {
      return
    }
    const previous = readGitHistorySnapshot(key)?.result ?? retained
    const generation = ++requestGeneration.current
    setState({
      key,
      owner,
      value: previous ? { status: 'refreshing', result: previous } : { status: 'loading' }
    })
    try {
      const result = await loadGitHistorySnapshot(
        key,
        () =>
          getRuntimeGitHistory(
            {
              target: requireGitOwnerTarget(activeRepoTarget),
              worktreeId: activeWorktreeId,
              worktreePath,
              connectionId: getConnectionId(activeWorktreeId) ?? undefined
            },
            { limit: 50, baseRef: compareBaseRef }
          ),
        true
      )
      if (generation === requestGeneration.current) {
        setState({ key, owner, value: { status: 'ready', result } })
      }
    } catch (error) {
      if (generation === requestGeneration.current) {
        setState({
          key,
          owner,
          value: {
            status: 'error',
            result: previous,
            error: error instanceof Error ? error.message : 'Failed to load commits'
          }
        })
      }
    }
  }, [
    activeRepoTarget,
    activeWorktreeId,
    worktreePath,
    compareBaseRef,
    isFolder,
    isBranchVisible,
    isGitHistoryExpanded,
    isGitHistoryVisible,
    key,
    owner,
    retained,
    worktreeMap
  ])
  const refreshGitHistoryRef = useRef(refreshGitHistory)
  useEffect(() => {
    refreshGitHistoryRef.current = refreshGitHistory
  }, [refreshGitHistory])
  useEffect(() => {
    if (activeWorktreeId && !worktreeMap.has(activeWorktreeId)) {
      requestGeneration.current += 1
      forgetGitHistorySnapshot(key)
      setState({ key, owner, value: EMPTY_GIT_HISTORY_STATE })
    }
  }, [activeWorktreeId, key, owner, worktreeMap])
  useEffect(() => {
    if (!isBranchVisible || !isGitHistoryExpanded || !isGitHistoryVisible) {
      return
    }
    const cached = readGitHistorySnapshot(key)
    if (!cached || Date.now() - cached.checkedAt >= GIT_HISTORY_SNAPSHOT_FRESH_MS) {
      void refreshGitHistoryRef.current()
    }
  }, [key, isBranchVisible, isGitHistoryExpanded, isGitHistoryVisible])
  return { gitHistoryState, refreshGitHistory, refreshGitHistoryRef }
}
