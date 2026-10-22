import { useCallback, useMemo, useRef, useState, type SetStateAction } from 'react'
import { resolveSourceControlGroupOrder } from '../listing/section-order'
import { getNextSourceControlViewMode } from './header-toolbar'
import { normalizeSourceControlViewMode } from '../commit/commit-drafts'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import {
  useSourceControlView,
  useSourceControlScrollPosition,
  updateSourceControlView
} from './source-control-view-memory'

// Keep each owner's presentation when panels unmount; dialogs remain local.
export function useSourceControlPanelViewState({
  activeWorktreeId,
  viewKey = activeWorktreeId,
  settings,
  updateSettings
}: {
  activeWorktreeId: string | null
  viewKey?: string | null
  settings: SourceControlWorktreeContext['settings']
  updateSettings: SourceControlStoreActions['updateSettings']
}) {
  const sourceControlRef = useRef<HTMLDivElement | null>(null)
  // Why: virtualize against the panel's shared scroller; use state (not a ref) so lists re-render and start observing once the element attaches.
  const [fileListScrollElement, setFileListScrollElement] = useState<HTMLDivElement | null>(null)
  const isMac = useMemo(() => navigator.userAgent.includes('Mac'), [])
  const view = useSourceControlView(viewKey)
  const { filterExpanded, filterQuery } = view
  const collapsedSections = useMemo(() => new Set(view.collapsedSections), [view.collapsedSections])
  const collapsedTreeDirs = useMemo(() => new Set(view.collapsedTreeDirs), [view.collapsedTreeDirs])
  const setFilterExpanded = useCallback(
    (value: SetStateAction<boolean>) =>
      updateSourceControlView(viewKey, (previous) => ({
        ...previous,
        filterExpanded: typeof value === 'function' ? value(previous.filterExpanded) : value
      })),
    [viewKey]
  )
  const setFilterQuery = useCallback(
    (value: SetStateAction<string>) =>
      updateSourceControlView(viewKey, (previous) => ({
        ...previous,
        filterQuery: typeof value === 'function' ? value(previous.filterQuery) : value
      })),
    [viewKey]
  )
  const persistedSourceControlViewMode = normalizeSourceControlViewMode(
    settings?.sourceControlViewMode
  )
  const sourceControlViewMode = persistedSourceControlViewMode
  const sourceControlGroupOrder = resolveSourceControlGroupOrder(settings?.sourceControlGroupOrder)
  const [baseRefDialogOpen, setBaseRefDialogOpen] = useState(false)
  const isGitHistoryExpanded = !collapsedSections.has('history')

  const handleToggleSourceControlViewMode = useCallback(() => {
    if (!settings) {
      return
    }
    updateSettings({
      sourceControlViewMode: getNextSourceControlViewMode(sourceControlViewMode)
    })
  }, [settings, sourceControlViewMode, updateSettings])

  // Why: reset during render instead of key-remounting on switch (which caused a Windows IPC storm).
  const [viewStateWorktreeId, setViewStateWorktreeId] = useState(activeWorktreeId)
  if (viewStateWorktreeId !== activeWorktreeId) {
    setViewStateWorktreeId(activeWorktreeId)
    setBaseRefDialogOpen(false)
    // Why: don't reset defaultBaseRef here — it's repo-scoped (resolved on activeRepo change); resetting would clobber non-main defaults.
    // Why: don't reset commit-in-flight state — it's per-worktree; resetting would re-enable Commit for an incoming worktree mid-commit.
  }

  useSourceControlScrollPosition(viewKey, 'scrollTop', fileListScrollElement)
  const toggleSection = useCallback(
    (section: string) => {
      updateSourceControlView(viewKey, (prev) => {
        const next = new Set(prev.collapsedSections)
        if (next.has(section)) {
          next.delete(section)
        } else {
          next.add(section)
        }
        return { ...prev, collapsedSections: [...next] }
      })
    },
    [viewKey]
  )

  const toggleTreeDir = useCallback(
    (key: string) => {
      updateSourceControlView(viewKey, (prev) => {
        const next = new Set(prev.collapsedTreeDirs)
        if (next.has(key)) {
          next.delete(key)
        } else {
          next.add(key)
        }
        return { ...prev, collapsedTreeDirs: [...next] }
      })
    },
    [viewKey]
  )

  return {
    sourceControlViewKey: viewKey,
    baseRefDialogOpen,
    collapsedSections,
    collapsedTreeDirs,
    fileListScrollElement,
    filterExpanded,
    filterQuery,
    handleToggleSourceControlViewMode,
    isGitHistoryExpanded,
    isMac,
    setBaseRefDialogOpen,
    setFileListScrollElement,
    setFilterExpanded,
    setFilterQuery,
    sourceControlGroupOrder,
    sourceControlRef,
    sourceControlViewMode,
    toggleSection,
    toggleTreeDir
  }
}

export type SourceControlPanelViewState = ReturnType<typeof useSourceControlPanelViewState>
