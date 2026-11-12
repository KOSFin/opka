import type { TaskPageStoreBindingsModel } from './use-task-page-store-bindings'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TaskProvider } from '../../../shared/task-providers'
import type { Repo } from '../../../shared/repo-types'
import { getRepoExecutionHostId, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  getDefaultTaskRepoSelection,
  normalizeTaskRepoSelection
} from './task-page-default-repo-selection'

export type TaskPageRepoSelectionStateBindings = Pick<
  TaskPageStoreBindingsModel,
  'updateSettings'
> & {
  settings: Partial<GlobalSettings> | null
  pageData: Partial<TaskPageStoreBindingsModel['pageData']>
}

export function useTaskPageRepoSelectionState(
  model: TaskPageRepoSelectionStateBindings,
  taskSource: TaskProvider,
  eligibleRepos: Repo[]
) {
  const { settings, pageData, updateSettings } = model
  // Repo IDs identify a host-specific checkout, so each provider retains its own project and host choices.
  const repoProvider = taskSource === 'gitlab' ? 'gitlab' : 'github'
  const selectionHost = settings?.activeRuntimeEnvironmentId?.trim() || 'local'
  const [selectionOverrides, setSelectionOverrides] = useState<
    Record<
      string,
      {
        github?: ReadonlySet<string>
        gitlab?: ReadonlySet<string>
      }
    >
  >({})
  const pendingSavedSelectionsRef = useRef(settings?.defaultRepoSelections ?? {})
  // Why: preselection wins so "open tasks for this repo" lands on that checkout.
  const resolvedInitialSelection = useMemo<ReadonlySet<string>>(() => {
    const preferred = pageData.preselectedRepoId
    if (preferred && eligibleRepos.some((repo) => repo.id === preferred)) {
      return new Set([preferred])
    }
    const savedSelection = settings?.defaultRepoSelections?.[selectionHost]?.[repoProvider]
    const legacy = settings?.defaultRepoSelection
    const focusedHostId =
      selectionHost === 'local' ? 'local' : toRuntimeExecutionHostId(selectionHost)
    const legacyForHost = Array.isArray(legacy)
      ? legacy.filter((id) =>
          eligibleRepos.some(
            (repo) => repo.id === id && getRepoExecutionHostId(repo) === focusedHostId
          )
        )
      : null
    const persisted =
      savedSelection !== undefined
        ? savedSelection
        : repoProvider === 'github'
          ? legacyForHost
          : null
    if (Array.isArray(persisted)) {
      return normalizeTaskRepoSelection(eligibleRepos, new Set(persisted))
    }
    return getDefaultTaskRepoSelection(eligibleRepos)
  }, [
    eligibleRepos,
    pageData.preselectedRepoId,
    repoProvider,
    selectionHost,
    settings?.defaultRepoSelection,
    settings?.defaultRepoSelections
  ])
  const repoSelection =
    selectionOverrides[selectionHost]?.[repoProvider] ?? resolvedInitialSelection
  const setRepoSelection = useCallback(
    (next: ReadonlySet<string>) => {
      setSelectionOverrides((current) => ({
        ...current,
        [selectionHost]: { ...current[selectionHost], [repoProvider]: next }
      }))
    },
    [repoProvider, selectionHost]
  )
  const saveRepoSelection = useCallback(
    (next: ReadonlySet<string> | null) => {
      const normalized =
        next === null
          ? getDefaultTaskRepoSelection(eligibleRepos)
          : normalizeTaskRepoSelection(eligibleRepos, next)
      setRepoSelection(normalized)
      const saved = {
        ...settings?.defaultRepoSelections,
        ...pendingSavedSelectionsRef.current,
        [selectionHost]: {
          ...settings?.defaultRepoSelections?.[selectionHost],
          ...pendingSavedSelectionsRef.current[selectionHost],
          [repoProvider]: next === null ? null : [...normalized]
        }
      }
      pendingSavedSelectionsRef.current = saved
      return updateSettings({ defaultRepoSelections: saved })
    },
    [
      eligibleRepos,
      repoProvider,
      selectionHost,
      setRepoSelection,
      settings?.defaultRepoSelections,
      updateSettings
    ]
  )
  return { resolvedInitialSelection, repoSelection, setRepoSelection, saveRepoSelection }
}
