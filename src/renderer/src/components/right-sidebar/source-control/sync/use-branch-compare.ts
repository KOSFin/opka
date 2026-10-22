import { useCallback, useEffect, useRef } from 'react'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { useAppStore } from '@/store'
import type { GitUpstreamStatus } from '../../../../../../shared/git-status-types'
import { shouldClearBranchCompareForMissingBase } from './base-ref-resolution'
import { slowTaskRequiredIdleMs } from '../../coalesced-poll-runner'
import { useBranchCompareRefreshTriggers } from './use-branch-compare-refresh-triggers'
import { readBranchCompareTiming, saveBranchCompareTiming } from './branch-compare-freshness'
import { useBranchCompareRead, type BranchCompareRefreshKind } from './use-branch-compare-read'

// Why: 30s poll — slow runs idle for their own duration; explicit commit/remote/manual/base-ref refreshes still run immediately.
export const BRANCH_REFRESH_INTERVAL_MS = 30_000
const BRANCH_REFRESH_IDLE_MULTIPLIER = 1
const BRANCH_REFRESH_MAX_INTERVAL_MS = 5 * 60_000

export function useSourceControlBranchCompare({
  activeRepoTarget,
  activeWorktreeId,
  worktreePath,
  compareBaseRef,
  isFolder,
  branchName,
  isBranchVisible,
  activeGitStatusHead,
  remoteStatus,
  viewKey
}: {
  activeRepoTarget: RuntimeClientTarget | null
  activeWorktreeId: string | null
  worktreePath: string | null
  compareBaseRef: string | null
  isFolder: boolean
  branchName: string
  isBranchVisible: boolean
  activeGitStatusHead: string | null
  remoteStatus: GitUpstreamStatus | undefined
  viewKey?: string | null
}) {
  const timingKey = JSON.stringify([
    viewKey ?? [activeRepoTarget, activeWorktreeId, worktreePath],
    compareBaseRef
  ])
  const remoteSignature = remoteStatus
    ? JSON.stringify([
        remoteStatus.hasUpstream,
        remoteStatus.upstreamName,
        remoteStatus.ahead,
        remoteStatus.behind
      ])
    : null
  const clearGitBranchCompare = useAppStore((s) => s.clearGitBranchCompare)
  const branchCompareInFlightRef = useRef(false)
  const branchCompareRerunRef = useRef<BranchCompareRefreshKind | null>(null)
  const branchCompareRunPromiseRef = useRef<Promise<void> | null>(null)
  const branchCompareRecoveryPendingRef = useRef(false)
  const refreshBranchCompareRef = useRef<() => Promise<void>>(async () => {})
  const recoverBranchCompareRef = useRef<() => Promise<void>>(async () => {})
  const startBranchCompareRef = useRef<(kind: BranchCompareRefreshKind) => Promise<void>>(
    async () => {}
  )
  const branchComparePollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const branchComparePollEnabledRef = useRef(false)
  const branchCompareLastRunEndedAtRef = useRef(-Infinity)
  const branchCompareLastRunDurationRef = useRef(0)
  useEffect(() => {
    const timing = readBranchCompareTiming(timingKey, activeGitStatusHead, remoteSignature)
    branchCompareLastRunEndedAtRef.current = timing?.endedAt ?? -Infinity
    branchCompareLastRunDurationRef.current = timing?.duration ?? 0
    if (timing && !timing.remote && remoteSignature) {
      saveBranchCompareTiming(timingKey, { ...timing, remote: remoteSignature })
    }
  }, [timingKey, activeGitStatusHead, remoteSignature])

  const runBranchCompare = useBranchCompareRead({
    activeRepoTarget,
    activeGitStatusHead,
    activeWorktreeId,
    branchName,
    compareBaseRef,
    isFolder,
    timingKey,
    remoteSignature,
    worktreePath
  })

  const clearBranchComparePollTimer = useCallback((): void => {
    if (branchComparePollTimerRef.current !== null) {
      clearTimeout(branchComparePollTimerRef.current)
      branchComparePollTimerRef.current = null
    }
  }, [])

  const scheduleBranchComparePoll = useCallback((): void => {
    if (!branchComparePollEnabledRef.current || branchComparePollTimerRef.current !== null) {
      return
    }
    const now = Date.now()
    const requiredIdleMs = slowTaskRequiredIdleMs(
      branchCompareLastRunDurationRef.current,
      BRANCH_REFRESH_IDLE_MULTIPLIER,
      BRANCH_REFRESH_INTERVAL_MS,
      BRANCH_REFRESH_MAX_INTERVAL_MS
    )
    const allowedAt = branchCompareLastRunEndedAtRef.current + requiredIdleMs
    if (now >= allowedAt) {
      void startBranchCompareRef.current('interval')
      return
    }
    branchComparePollTimerRef.current = setTimeout(() => {
      branchComparePollTimerRef.current = null
      if (branchComparePollEnabledRef.current) {
        void startBranchCompareRef.current('interval')
      }
    }, allowedAt - now)
  }, [])

  const startBranchCompare = useCallback(
    async (kind: BranchCompareRefreshKind) => {
      if (kind !== 'interval') {
        clearBranchComparePollTimer()
      }
      if (branchCompareInFlightRef.current) {
        if (
          branchCompareRerunRef.current !== 'immediate' &&
          (kind !== 'interval' || branchCompareRerunRef.current === null)
        ) {
          branchCompareRerunRef.current = kind
        }
        return branchCompareRunPromiseRef.current ?? undefined
      }
      if (kind === 'interval') {
        const requiredIdleMs = slowTaskRequiredIdleMs(
          branchCompareLastRunDurationRef.current,
          BRANCH_REFRESH_IDLE_MULTIPLIER,
          BRANCH_REFRESH_INTERVAL_MS,
          BRANCH_REFRESH_MAX_INTERVAL_MS
        )
        if (Date.now() < branchCompareLastRunEndedAtRef.current + requiredIdleMs) {
          scheduleBranchComparePoll()
          return
        }
      }
      clearBranchComparePollTimer()
      branchCompareInFlightRef.current = true
      const startedAt = Date.now()
      const runPromise = (async (): Promise<void> => {
        // Why: keep one branch-compare chain in flight and collapse skipped ticks into one trailing refresh instead of stacking git subprocesses.
        try {
          await runBranchCompare(kind)
        } finally {
          const endedAt = Date.now()
          branchCompareLastRunEndedAtRef.current = endedAt
          branchCompareLastRunDurationRef.current = endedAt - startedAt
          branchCompareInFlightRef.current = false
          const rerunKind = branchCompareRerunRef.current
          branchCompareRerunRef.current = null
          const recoveryPending = branchCompareRecoveryPendingRef.current
          branchCompareRecoveryPendingRef.current = false
          if (rerunKind === 'immediate') {
            await refreshBranchCompareRef.current()
          } else if (recoveryPending) {
            await recoverBranchCompareRef.current()
          } else if (rerunKind === 'interval') {
            scheduleBranchComparePoll()
          }
        }
      })()
      branchCompareRunPromiseRef.current = runPromise
      await runPromise.finally(() => {
        if (branchCompareRunPromiseRef.current === runPromise) {
          branchCompareRunPromiseRef.current = null
        }
      })
    },
    [clearBranchComparePollTimer, runBranchCompare, scheduleBranchComparePoll]
  )
  const refreshBranchCompare = useCallback(
    () => startBranchCompare('immediate'),
    [startBranchCompare]
  )
  const recoverBranchCompare = useCallback((): Promise<void> => {
    const summary = useAppStore.getState().gitBranchCompareSummaryByWorktree[activeWorktreeId ?? '']
    // Why: an in-flight result may recover visible data; loading, missing, changed-base, and failed results retry immediately.
    if (
      summary &&
      summary.status !== 'loading' &&
      summary.status !== 'error' &&
      summary.baseRef === compareBaseRef
    ) {
      scheduleBranchComparePoll()
      return Promise.resolve()
    }
    if (branchCompareInFlightRef.current) {
      branchCompareRecoveryPendingRef.current = true
      return branchCompareRunPromiseRef.current ?? Promise.resolve()
    }
    return refreshBranchCompareRef.current()
  }, [activeWorktreeId, compareBaseRef, scheduleBranchComparePoll])
  // Why: publish in an effect, not the render body — a discarded render must not install its callback. Declared first so the effects below see the fresh one.
  useEffect(() => {
    refreshBranchCompareRef.current = refreshBranchCompare
    recoverBranchCompareRef.current = recoverBranchCompare
    startBranchCompareRef.current = startBranchCompare
  }, [recoverBranchCompare, refreshBranchCompare, startBranchCompare])

  useBranchCompareRefreshTriggers({
    activeWorktreeId,
    worktreePath,
    compareBaseRef,
    isFolder,
    isBranchVisible,
    activeGitStatusHead,
    remoteStatus,
    isCurrentResultFresh: () => {
      const timing = readBranchCompareTiming(timingKey, activeGitStatusHead, remoteSignature)
      const summary =
        useAppStore.getState().gitBranchCompareSummaryByWorktree[activeWorktreeId ?? '']
      return Boolean(
        timing &&
        summary?.status === 'ready' &&
        summary.baseRef === compareBaseRef &&
        Date.now() - timing.endedAt < BRANCH_REFRESH_INTERVAL_MS
      )
    },
    refreshBranchCompareRef
  })

  useEffect(() => {
    if (!activeWorktreeId || !worktreePath || !isBranchVisible || !compareBaseRef || isFolder) {
      return
    }
    // Why: HEAD changes refresh branch compare immediately; keep a visible-window fallback for base/remote updates that don't move HEAD.
    branchComparePollEnabledRef.current = true
    const stopInterval = installWindowVisibilityInterval({
      run: () => void startBranchCompareRef.current('interval'),
      runOnVisible: () => void recoverBranchCompareRef.current(),
      jitterOnVisible: true,
      intervalMs: BRANCH_REFRESH_INTERVAL_MS
    })
    return () => {
      branchComparePollEnabledRef.current = false
      clearBranchComparePollTimer()
      stopInterval()
    }
  }, [
    activeWorktreeId,
    clearBranchComparePollTimer,
    compareBaseRef,
    isBranchVisible,
    isFolder,
    worktreePath
  ])

  useEffect(() => {
    // Why: when compare-base resolves to no base, drop the stale summary (gate on loaded upstream status to avoid flicker).
    if (
      !activeWorktreeId ||
      !shouldClearBranchCompareForMissingBase({
        isFolder,
        compareBaseRef,
        remoteStatus
      })
    ) {
      return
    }
    clearGitBranchCompare(activeWorktreeId)
  }, [activeWorktreeId, clearGitBranchCompare, compareBaseRef, isFolder, remoteStatus])

  return { refreshBranchCompare, refreshBranchCompareRef }
}
