import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  FILE_EXPLORER_FULL_ROOT,
  normalizeExplorerDisplayRootChoice,
  resolveExplorerDisplayRootChoice,
  type ExplorerRootOption
} from './file-explorer-display-root'

type ExplorerRootHistory = { worktreeId: string | null; back: string[]; forward: string[] }
const HISTORY_LIMIT = 50

export function useFileExplorerRootNavigation(
  worktreeId: string | null,
  choice: string,
  options: ExplorerRootOption[] | null
) {
  const [returnTarget, setReturnTarget] = useState<{ worktreeId: string; choice: string } | null>(
    null
  )
  const historyRef = useRef<ExplorerRootHistory>({ worktreeId, back: [], forward: [] })
  const [history, setHistory] = useState(historyRef.current)
  const currentHistory = history.worktreeId === worktreeId ? history : null
  const updateHistory = useCallback((next: ExplorerRootHistory) => {
    historyRef.current = next
    setHistory(next)
  }, [])
  const writeRoot = useCallback(
    (value: string) => {
      if (!worktreeId) {
        return
      }
      setReturnTarget(null)
      const state = useAppStore.getState()
      state.clearPendingExplorerReveal()
      state.setExplorerDisplayRootForWorktree(worktreeId, value)
    },
    [worktreeId]
  )
  const selectRoot = useCallback(
    (value: string) => {
      const normalized = normalizeExplorerDisplayRootChoice(value)
      if (
        !worktreeId ||
        !normalized ||
        normalized === choice ||
        resolveExplorerDisplayRootChoice(options, normalized) !== normalized
      ) {
        return
      }
      const previous = historyRef.current
      updateHistory({
        worktreeId,
        back: [...(previous.worktreeId === worktreeId ? previous.back : []), choice].slice(
          -HISTORY_LIMIT
        ),
        forward: []
      })
      writeRoot(normalized)
    },
    [choice, options, updateHistory, worktreeId, writeRoot]
  )
  const goBack = useCallback(() => {
    if (!worktreeId || historyRef.current.worktreeId !== worktreeId) {
      return
    }
    const previous = historyRef.current
    const target = previous.back.at(-1)
    if (!target) {
      return
    }
    if (resolveExplorerDisplayRootChoice(options, target) !== target) {
      updateHistory({ worktreeId, back: [], forward: [] })
      return
    }
    updateHistory({
      worktreeId,
      back: previous.back.slice(0, -1),
      forward: [choice, ...previous.forward].slice(0, HISTORY_LIMIT)
    })
    writeRoot(target)
  }, [choice, options, updateHistory, worktreeId, writeRoot])
  const goForward = useCallback(() => {
    if (!worktreeId || historyRef.current.worktreeId !== worktreeId) {
      return
    }
    const previous = historyRef.current
    const target = previous.forward[0]
    if (!target) {
      return
    }
    if (resolveExplorerDisplayRootChoice(options, target) !== target) {
      updateHistory({ worktreeId, back: [], forward: [] })
      return
    }
    updateHistory({
      worktreeId,
      back: [...previous.back, choice].slice(-HISTORY_LIMIT),
      forward: previous.forward.slice(1)
    })
    writeRoot(target)
  }, [choice, options, updateHistory, worktreeId, writeRoot])
  const goUp = useCallback(() => {
    if (choice === FILE_EXPLORER_FULL_ROOT) {
      return
    }
    const parts = choice.split('/')
    const parent = parts.length === 1 ? FILE_EXPLORER_FULL_ROOT : parts.slice(0, -1).join('/')
    selectRoot(
      resolveExplorerDisplayRootChoice(options, parent) === parent
        ? parent
        : FILE_EXPLORER_FULL_ROOT
    )
  }, [choice, options, selectRoot])
  const revealOutsideRoot = useCallback(() => {
    if (!worktreeId || choice === FILE_EXPLORER_FULL_ROOT) {
      return
    }
    setReturnTarget({ worktreeId, choice })
    useAppStore.getState().setExplorerDisplayRootForWorktree(worktreeId, FILE_EXPLORER_FULL_ROOT)
  }, [worktreeId, choice])
  const returnRoot =
    choice === FILE_EXPLORER_FULL_ROOT && returnTarget?.worktreeId === worktreeId
      ? resolveExplorerDisplayRootChoice(options, returnTarget.choice) === returnTarget.choice
        ? (options?.find((option) => option.value === returnTarget.choice) ?? {
            value: returnTarget.choice,
            label: returnTarget.choice
          })
        : null
      : null
  return {
    selectRoot,
    revealOutsideRoot,
    returnRoot,
    goBack,
    goForward,
    goUp,
    canGoBack: Boolean(currentHistory?.back.length),
    canGoForward: Boolean(currentHistory?.forward.length)
  }
}
