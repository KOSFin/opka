import React from 'react'
import { useAppStore } from '../../store'
import type {
  AutomationCommandDefinitionV1,
  AutomationCommandReportTargetOption
} from '../../../../shared/automation-command-domain'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import {
  commandAutomationEditorSetupsForTarget,
  listCommandAutomationRunsForTarget,
  listCommandAutomationsAndReportTargetsForTarget
} from './automation-command-host-client'
import {
  getAutomationHostTargetFromKey,
  getAutomationHostTargetKey,
  type AutomationHostTarget
} from './automation-host-client'
import {
  selectCommandDefinitionId,
  selectCommandReportRunId,
  visibleCommandReportRun,
  missingCommandDefinitionReport,
  missingCommandRunReport,
  settleVisibleCommandCreate,
  commandHostErrorMessage,
  type RequestedCommandReport
} from './automation-command-report-selection'
import { pendingCommandRequests } from './automation-command-pending-requests'
import { useAutomationCommandViewFence } from './use-automation-command-view-fence'
import { saveCommandAutomationDraft } from './automation-command-save-operation'
import { createAutomationCommandDetailActions } from './automation-command-detail-actions'
import {
  draftFromCommandAutomation,
  emptyAutomationCommandDraft,
  type AutomationCommandDraft
} from './automation-command-draft'

type Props = {
  target: AutomationHostTarget
  requestedReport?: RequestedCommandReport | null
  selectionId?: string | null
  onChanged(): void
  onRemoved(): void
}

export function useAutomationCommandState({
  target,
  requestedReport,
  selectionId,
  onChanged,
  onRemoved
}: Props) {
  const [setups, setSetups] = React.useState<ProjectHostSetup[]>([])
  const [definitions, setDefinitions] = React.useState<AutomationCommandDefinitionV1[]>([])
  const [reportTargets, setReportTargets] = React.useState<AutomationCommandReportTargetOption[]>(
    []
  )
  const [selectedId, setSelectedId] = React.useState<string | null>(selectionId ?? null)
  const [runs, setRuns] = React.useState<AutomationRun[]>([])
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState<AutomationCommandDraft>(emptyAutomationCommandDraft)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  React.useEffect(() => {
    setSelectedId(selectionId ?? null)
    setBusy(false)
  }, [selectionId])
  const targetKey = getAutomationHostTargetKey(target)
  const pending = React.useMemo(() => pendingCommandRequests(targetKey), [targetKey])
  const view = useAutomationCommandViewFence(`${targetKey}:${selectionId ?? ''}`)
  const stableTarget = React.useMemo<AutomationHostTarget>(
    () => getAutomationHostTargetFromKey(targetKey) ?? { kind: 'local' },
    [targetKey]
  )
  const definitionRequest = React.useRef(0)
  const runRequest = React.useRef(0)
  const selected = definitions.find((definition) => definition.id === selectedId) ?? null
  const selectedRun = visibleCommandReportRun(runs, selectedRunId, selectedId, requestedReport)
  const selectedPendingRun = selected ? (pending.runs.get(selected.id) ?? null) : null

  const refresh = React.useCallback(async (): Promise<void> => {
    const request = ++definitionRequest.current
    try {
      const [{ definitions: next, reportTargets: availableTargets }, nextSetups] =
        await Promise.all([
          listCommandAutomationsAndReportTargetsForTarget(stableTarget),
          commandAutomationEditorSetupsForTarget(stableTarget)
        ])
      if (request !== definitionRequest.current) {
        return
      }
      setSetups(nextSetups)
      setDefinitions(next)
      setReportTargets(availableTargets)
      settleVisibleCommandCreate(pending, next)
      setSelectedId((id) => selectCommandDefinitionId(next, id, requestedReport))
      setError(missingCommandDefinitionReport(next, requestedReport))
    } catch (cause) {
      if (request !== definitionRequest.current) {
        return
      }
      setSetups([])
      setDefinitions([])
      setReportTargets([])
      setSelectedId(null)
      setError(commandHostErrorMessage(cause))
    }
  }, [stableTarget, pending, requestedReport])

  React.useEffect(() => {
    setDefinitions([])
    setReportTargets([])
    setRuns([])
    setDraft(emptyAutomationCommandDraft())
    setEditingId(null)
    setError(null)
    setNotice(null)
    setBusy(false)
    setConfirmDelete(false)
    setSelectedRunId(null)
    void refresh()
    return () => {
      definitionRequest.current += 1
      runRequest.current += 1
    }
  }, [refresh])

  const refreshRuns = React.useCallback(async (): Promise<void> => {
    const request = ++runRequest.current
    if (!selectedId) {
      setRuns([])
      return
    }
    try {
      const next = await listCommandAutomationRunsForTarget(stableTarget, selectedId)
      if (request !== runRequest.current) {
        return
      }
      setRuns(next)
      const linkedRun = requestedReport?.automationId === selectedId ? requestedReport.runId : null
      setSelectedRunId((id) => selectCommandReportRunId(next, id, linkedRun))
      setError(missingCommandRunReport(next, linkedRun))
      if (linkedRun && next.some((run) => run.id === linkedRun)) {
        useAppStore.getState().setPendingCommandAutomationReportNavigation(null)
      }
    } catch (cause) {
      if (request !== runRequest.current) {
        return
      }
      setRuns([])
      setError(commandHostErrorMessage(cause))
    }
  }, [selectedId, stableTarget, requestedReport])

  React.useEffect(() => {
    setRuns([])
    void refreshRuns()
  }, [refreshRuns])

  const openCreate = (): void => {
    view.advance()
    setDraft(pending.create?.draft ?? emptyAutomationCommandDraft())
    setEditingId(null)
    setEditorOpen(true)
    setError(null)
  }
  const openEdit = (): void => {
    if (!selected) {
      return
    }
    view.advance()
    setDraft(draftFromCommandAutomation(selected))
    setEditingId(selected.id)
    setEditorOpen(true)
    setError(null)
  }
  const save = async (): Promise<boolean> => {
    if (editingId && selected?.id !== editingId) {
      setError('The selected automation changed. Reopen it before saving.')
      return false
    }
    const actionEpoch = view.capture()
    setBusy(true)
    try {
      const { saved, createRequest } = await saveCommandAutomationDraft({
        target: stableTarget,
        setups,
        reportTargets,
        draft,
        editingId,
        selected,
        pending
      })
      if (!view.current(actionEpoch)) {
        return false
      }
      setEditorOpen(false)
      if (pending.create === createRequest) {
        pending.create = null
      }
      setSelectedId(saved.id)
      setNotice('Saved on the selected execution host.')
      setError(null)
      await refresh()
      onChanged()
      return view.current(actionEpoch)
    } catch (cause) {
      if (view.current(actionEpoch)) {
        setError(commandHostErrorMessage(cause))
      }
      return false
    } finally {
      if (view.current(actionEpoch)) {
        setBusy(false)
      }
    }
  }
  const detailActions = createAutomationCommandDetailActions({
    stableTarget,
    selected,
    selectedRun,
    pending,
    view,
    setBusy,
    setError,
    setNotice,
    setConfirmDelete,
    refresh,
    refreshRuns,
    onChanged,
    onRemoved
  })

  return {
    setups,
    definitions,
    selected,
    selectedId,
    runs,
    selectedRun,
    busy,
    error,
    notice,
    editorOpen,
    editingId,
    draft,
    reportTargets,
    confirmDelete,
    stableTarget,
    pending,
    selectedPendingRun,
    view,
    refresh,
    refreshRuns,
    openCreate,
    openEdit,
    save,
    ...detailActions,
    setBusy,
    setEditorOpen,
    setDraft,
    setConfirmDelete,
    setSelectedRunId,
    setError,
    setNotice
  }
}

export type AutomationCommandState = ReturnType<typeof useAutomationCommandState>
