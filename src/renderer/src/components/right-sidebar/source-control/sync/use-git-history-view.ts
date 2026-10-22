import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { GitHistoryItem, GitHistoryResult } from '../../../../../../shared/git-history'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitHistoryCommitFilesState } from './git-history-commit-files'
import { readGitHistoryFiles, saveGitHistoryFiles } from './git-history-snapshots'
import {
  useSourceControlScrollPosition,
  useSourceControlView,
  updateSourceControlView
} from '../panel/source-control-view-memory'

export const MIN_GIT_HISTORY_PANEL_HEIGHT = 96
export const MAX_GIT_HISTORY_PANEL_HEIGHT = 520
const clampHeight = (height: number) =>
  Math.min(MAX_GIT_HISTORY_PANEL_HEIGHT, Math.max(MIN_GIT_HISTORY_PANEL_HEIGHT, height))

export function useGitHistoryView(
  viewKey: string | null | undefined,
  result: GitHistoryResult | undefined,
  collapsed: boolean,
  onLoadCommitFiles?: (item: GitHistoryItem) => Promise<GitBranchChangeEntry[]>
) {
  const localKey = useId()
  const scope = viewKey ?? localKey
  const view = useSourceControlView(scope)
  const panelHeight = view.historyHeight
  const expanded = useMemo(() => new Set(view.expandedCommits), [view.expandedCommits])
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  useSourceControlScrollPosition(scope, 'historyScrollTop', scrollElement)
  const [filesByCommit, setFilesByCommit] = useState<Record<string, GitHistoryCommitFilesState>>(
    () =>
      Object.fromEntries(
        (result?.items ?? []).flatMap((item) => {
          const entries = readGitHistoryFiles(scope, item.id)
          return entries ? [[item.id, { status: 'ready', entries }]] : []
        })
      )
  )
  const pending = useRef(new Set<string>())
  const activeScope = useRef(scope)
  useLayoutEffect(() => {
    activeScope.current = scope
  }, [scope])
  const [filesScope, setFilesScope] = useState(scope)
  if (filesScope !== scope) {
    setFilesScope(scope)
    setFilesByCommit({})
    pending.current = new Set()
  }
  // Cached files must precede scroll restoration, not arrive in a later effect.
  const visibleFilesByCommit = useMemo(() => {
    const visible = { ...filesByCommit }
    for (const item of result?.items ?? []) {
      if (!visible[item.id]) {
        const entries = readGitHistoryFiles(scope, item.id)
        if (entries) {
          visible[item.id] = { status: 'ready', entries }
        }
      }
    }
    return visible
  }, [filesByCommit, result, scope])
  const loadFiles = useCallback(
    (item: GitHistoryItem) => {
      if (
        !onLoadCommitFiles ||
        pending.current.has(item.id) ||
        filesByCommit[item.id]?.status === 'ready'
      ) {
        return
      }
      const cached = readGitHistoryFiles(scope, item.id)
      if (cached) {
        setFilesByCommit((previous) => ({
          ...previous,
          [item.id]: { status: 'ready', entries: cached }
        }))
        return
      }
      const requestSet = pending.current
      requestSet.add(item.id)
      setFilesByCommit((previous) => ({ ...previous, [item.id]: { status: 'loading' } }))
      void onLoadCommitFiles(item)
        .then((entries) => {
          saveGitHistoryFiles(scope, item.id, entries)
          if (activeScope.current === scope) {
            setFilesByCommit((previous) => ({
              ...previous,
              [item.id]: { status: 'ready', entries }
            }))
          }
        })
        .catch((error: unknown) => {
          if (activeScope.current === scope) {
            setFilesByCommit((previous) => ({
              ...previous,
              [item.id]: {
                status: 'error',
                error: error instanceof Error ? error.message : 'Failed to load commit files'
              }
            }))
          }
        })
        .finally(() => {
          requestSet.delete(item.id)
        })
    },
    [filesByCommit, onLoadCommitFiles, scope]
  )
  useEffect(() => {
    if (collapsed) {
      return
    }
    for (const item of result?.items ?? []) {
      if (expanded.has(item.id) && !visibleFilesByCommit[item.id]) {
        loadFiles(item)
      }
    }
  }, [collapsed, expanded, visibleFilesByCommit, loadFiles, result])
  const handleToggleExpand = useCallback(
    (item: GitHistoryItem) => {
      const opening = !expanded.has(item.id)
      updateSourceControlView(scope, (previous) => {
        const next = new Set(previous.expandedCommits)
        if (opening) {
          next.add(item.id)
        } else {
          next.delete(item.id)
        }
        return { ...previous, expandedCommits: [...next] }
      })
      if (opening) {
        loadFiles(item)
      }
    },
    [expanded, loadFiles, scope]
  )
  const resizeSession = useRef<{
    startY: number
    startHeight: number
    previousCursor: string
    previousUserSelect: string
  } | null>(null)
  const setPanelHeight = useCallback(
    (height: number) =>
      updateSourceControlView(scope, (previous) => ({
        ...previous,
        historyHeight: clampHeight(height)
      })),
    [scope]
  )
  const stopResize = useCallback(() => {
    const session = resizeSession.current
    if (!session) {
      return
    }
    resizeSession.current = null
    document.body.style.cursor = session.previousCursor
    document.body.style.userSelect = session.previousUserSelect
  }, [])
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const session = resizeSession.current
      if (session) {
        setPanelHeight(session.startHeight + session.startY - event.clientY)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
    window.addEventListener('blur', stopResize)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
      window.removeEventListener('blur', stopResize)
      stopResize()
    }
  }, [setPanelHeight, stopResize])
  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) {
        return
      }
      event.preventDefault()
      resizeSession.current = {
        startY: event.clientY,
        startHeight: panelHeight,
        previousCursor: document.body.style.cursor,
        previousUserSelect: document.body.style.userSelect
      }
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [collapsed, panelHeight]
  )
  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 32 : 16
      const next =
        event.key === 'ArrowUp'
          ? panelHeight + step
          : event.key === 'ArrowDown'
            ? panelHeight - step
            : event.key === 'Home'
              ? MIN_GIT_HISTORY_PANEL_HEIGHT
              : event.key === 'End'
                ? MAX_GIT_HISTORY_PANEL_HEIGHT
                : null
      if (next === null) {
        return
      }
      event.preventDefault()
      setPanelHeight(next)
    },
    [panelHeight, setPanelHeight]
  )
  return {
    panelHeight,
    expanded,
    filesByCommit: visibleFilesByCommit,
    handleToggleExpand,
    handleResizeKeyDown,
    startResize,
    setScrollElement
  }
}
