import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react'
import { BoundedMap } from '../../../../../../shared/bounded-map'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'

export type SourceControlView = {
  collapsedSections: string[]
  collapsedTreeDirs: string[]
  filterExpanded: boolean
  filterQuery: string
  historyHeight: number
  expandedCommits: string[]
  repositoryId: string | null
  workingCopyId: string | null
}
const DEFAULT_VIEW: SourceControlView = {
  collapsedSections: ['history'],
  collapsedTreeDirs: [],
  filterExpanded: false,
  filterQuery: '',
  historyHeight: 256,
  expandedCommits: [],
  repositoryId: null,
  workingCopyId: null
}
const views = new BoundedMap<string, SourceControlView>({
  maxEntries: 512,
  maxBytes: 2 * 1024 * 1024,
  sizeOf: (view) => new TextEncoder().encode(JSON.stringify(view)).length
})
const listeners = new Set<() => void>()
const scrollPositions = new BoundedMap<string, number>({ maxEntries: 1024 })
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function sourceControlViewKey(input: {
  target: RuntimeClientTarget | null
  worktreeId: string | null
  path: string | null
  instanceId?: string
  connectionId?: string | null
}): string | null {
  return input.worktreeId
    ? JSON.stringify([
        input.target,
        input.connectionId ?? null,
        input.worktreeId,
        input.instanceId ?? null,
        input.path
      ])
    : null
}
export function readSourceControlView(key: string | null): SourceControlView {
  return (key ? views.peek(key) : undefined) ?? DEFAULT_VIEW
}
export function updateSourceControlView(
  key: string | null,
  update: (view: SourceControlView) => SourceControlView
) {
  if (!key) {
    return
  }
  const previous = readSourceControlView(key)
  const next = update(previous)
  if (next !== previous && views.set(key, next)) {
    listeners.forEach((listener) => listener())
  }
}
export function useSourceControlView(key: string | null) {
  const snapshot = useCallback(() => readSourceControlView(key), [key])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
export function clearSourceControlViewsForTests() {
  views.clear()
  scrollPositions.clear()
  listeners.forEach((listener) => listener())
}

export function useSourceControlScrollPosition(
  key: string | null,
  field: 'scrollTop' | 'historyScrollTop',
  element: HTMLDivElement | null
) {
  useLayoutEffect(() => {
    if (!element) {
      return
    }
    const positionKey = JSON.stringify([key, field])
    element.scrollTop = scrollPositions.get(positionKey) ?? 0
    const save = () => {
      scrollPositions.set(positionKey, element.scrollTop)
    }
    element.addEventListener('scroll', save, { passive: true })
    return () => element.removeEventListener('scroll', save)
  }, [element, field, key])
}
