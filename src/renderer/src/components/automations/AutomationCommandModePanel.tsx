import React from 'react'
import { useAppStore } from '../../store'
import type {
  AutomationCommandDefinitionV1,
  AutomationCommandReportTargetOption
} from '../../../../shared/automation-command-domain'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import {
  deleteCommandAutomationForTarget,
  listCommandAutomationRunsForTarget,
  listCommandAutomationsAndReportTargetsForTarget
} from './automation-command-host-client'
import {
  getAutomationHostTargetFromKey,
  getAutomationHostTargetKey,
  type AutomationHostTarget
} from './automation-host-client'
import { AutomationCommandModeDialogs } from './AutomationCommandModeDialogs'
import { AutomationCommandModeContent } from './AutomationCommandModeContent'
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
import { AutomationCommandModeToolbar } from './AutomationCommandModeToolbar'
import { AutomationCommandArchive } from './AutomationCommandArchive'
import { pendingCommandRequests } from './automation-command-pending-requests'
import { useAutomationCommandViewFence } from './use-automation-command-view-fence'
import { saveCommandAutomationDraft } from './automation-command-save-operation'
import { requestCommandRunCancel } from './automation-command-cancel-operation'
import { admitCommandManualRun } from './automation-command-run-operation'
import {
  draftFromCommandAutomation,
  emptyAutomationCommandDraft,
  type AutomationCommandDraft
} from './automation-command-draft'

type Props = {
  target: AutomationHostTarget
  setups: readonly ProjectHostSetup[]
  requestedReport?: RequestedCommandReport | null
  onBack(): void
}

export function AutomationCommandModePanel({
  target,
  setups,
  requestedReport,
  onBack
}: Props): React.JSX.Element {
  const [definitions, setDefinitions] = React.useState<AutomationCommandDefinitionV1[]>([])
  const [reportTargets, setReportTargets] = React.useState<AutomationCommandReportTargetOption[]>(
    []
  )
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [runs, setRuns] = React.useState<AutomationRun[]>([])
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState<AutomationCommandDraft>(emptyAutomationCommandDraft)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [archiveOpen, setArchiveOpen] = React.useState(false)
  const targetKey = getAutomationHostTargetKey(target)
  const pending = React.useMemo(() => pendingCommandRequests(targetKey), [targetKey])
  const view = useAutomationCommandViewFence(targetKey)
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
      const { definitions: next, reportTargets: availableTargets } =
        await listCommandAutomationsAndReportTargetsForTarget(stableTarget)
      if (request !== definitionRequest.current) {
        return
      }
      setDefinitions(next)
      setReportTargets(availableTargets)
      settleVisibleCommandCreate(pending, next)
      setSelectedId((id) => selectCommandDefinitionId(next, id, requestedReport))
      setError(missingCommandDefinitionReport(next, requestedReport))
    } catch (cause) {
      if (request !== definitionRequest.current) {
        return
      }
      setDefinitions([])
      setReportTargets([])
      setSelectedId(null)
      setError(commandHostErrorMessage(cause))
    }
  }, [stableTarget, pending, requestedReport])

  React.useEffect(() => {
    setDefinitions([])
    setReportTargets([])
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
  const save = async (): Promise<void> => {
    if (editingId && selected?.id !== editingId) {
      setError('The selected automation changed. Reopen it before saving.')
      return
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
        return
      }
      setEditorOpen(false)
      if (pending.create === createRequest) {
        pending.create = null
      }
      setSelectedId(saved.id)
      setNotice('Saved on the selected execution host.')
      setError(null)
      await refresh()
    } catch (cause) {
      if (view.current(actionEpoch)) {
        setError(commandHostErrorMessage(cause))
      }
    } finally {
      if (view.current(actionEpoch)) {
        setBusy(false)
      }
    }
  }
  const runNow = async (): Promise<void> => {
    if (!selected) {
      return
    }
    const actionEpoch = view.capture()
    setBusy(true)
    try {
      const { admission, request } = await admitCommandManualRun(stableTarget, selected, pending)
      if (!view.current(actionEpoch)) {
        return
      }
      if (pending.runs.get(request.id) === request) {
        pending.runs.delete(request.id)
      }
      setNotice(
        admission.kind === 'overlap'
          ? 'An active run already owns this automation.'
          : 'Run admitted. Refresh history for its report.'
      )
      setError(null)
      await refreshRuns()
    } catch (cause) {
      if (view.current(actionEpoch)) {
        setError(commandHostErrorMessage(cause))
      }
    } finally {
      if (view.current(actionEpoch)) {
        setBusy(false)
      }
    }
  }
  const cancel = async (): Promise<void> => {
    if (!selected || !selectedRun) {
      return
    }
    const actionEpoch = view.capture()
    setBusy(true)
    try {
      const { request, observation } = await requestCommandRunCancel(
        stableTarget,
        selected.id,
        selectedRun.id,
        pending
      )
      if (!view.current(actionEpoch)) {
        return
      }
      if (pending.cancels.get(request.runId) === request) {
        pending.cancels.delete(request.runId)
      }
      setNotice(`Cancellation requested; host observation: ${observation}.`)
      setError(null)
      await refreshRuns()
    } catch (cause) {
      if (view.current(actionEpoch)) {
        setError(commandHostErrorMessage(cause))
      }
    } finally {
      if (view.current(actionEpoch)) {
        setBusy(false)
      }
    }
  }
  const remove = async (): Promise<void> => {
    if (!selected) {
      return
    }
    const { id, revision } = selected
    const actionEpoch = view.capture()
    setBusy(true)
    try {
      await deleteCommandAutomationForTarget(stableTarget, id, revision)
      if (!view.current(actionEpoch)) {
        return
      }
      setConfirmDelete(false)
      setArchiveOpen(true)
      setNotice('Automation removed from this host.')
      setError(null)
      await refresh()
    } catch (cause) {
      if (view.current(actionEpoch)) {
        setError(commandHostErrorMessage(cause))
      }
    } finally {
      if (view.current(actionEpoch)) {
        setBusy(false)
      }
    }
  }

  return (
    <main className="flex h-full min-h-0 flex-col bg-background p-5 text-foreground">
      <AutomationCommandModeToolbar
        busy={busy}
        canCreate={!error}
        onBack={() => {
          view.advance()
          onBack()
        }}
        onRefresh={() => void refresh()}
        onOpenReports={() => setArchiveOpen(true)}
        onCreate={openCreate}
      />
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-4 text-sm">
          {notice}
        </p>
      )}
      {archiveOpen ? (
        <AutomationCommandArchive target={stableTarget} onClose={() => setArchiveOpen(false)} />
      ) : (
        <AutomationCommandModeContent
          definitions={definitions}
          selectedId={selectedId}
          busy={busy}
          onSelectDefinition={(id) => {
            view.advance()
            useAppStore.getState().setPendingCommandAutomationReportNavigation(null)
            setError(null)
            setSelectedId(id)
            setConfirmDelete(false)
          }}
          selected={selected}
          runs={runs}
          selectedRun={selectedRun}
          retrySameRequest={selected ? pending.runs.has(selected.id) : false}
          target={stableTarget}
          pendingRun={selectedPendingRun}
          onRunReconciled={(runId, overlap) => {
            if (!selected || pending.runs.get(selected.id) !== selectedPendingRun) {
              return
            }
            pending.runs.delete(selected.id)
            setNotice(
              overlap
                ? 'The prior request overlapped an active run.'
                : 'The prior request already admitted a run.'
            )
            setError(null)
            setSelectedRunId(runId)
            void refreshRuns()
          }}
          onStartNewRun={() => {
            if (!selected || pending.runs.get(selected.id) !== selectedPendingRun) {
              return
            }
            pending.runs.delete(selected.id)
            setError(null)
            void runNow()
          }}
          onEdit={openEdit}
          onRun={() => void runNow()}
          onRemove={() => setConfirmDelete(true)}
          onSelectRun={(id) => {
            useAppStore.getState().setPendingCommandAutomationReportNavigation(null)
            setError(null)
            setSelectedRunId(id)
          }}
          onRefreshRuns={() => void refreshRuns()}
          onCancel={() => void cancel()}
        />
      )}
      <AutomationCommandModeDialogs
        editorOpen={editorOpen}
        editing={editingId !== null}
        pendingCreate={editingId === null && pending.create !== null}
        busy={busy}
        draft={draft}
        setups={setups}
        reportTargets={reportTargets}
        error={error}
        removeName={confirmDelete ? (selected?.name ?? null) : null}
        onEditorOpenChange={(open) => {
          if (!open && busy) {
            return
          }
          if (!open) {
            view.advance()
          }
          setEditorOpen(open)
        }}
        onDraftChange={(next) => {
          if (editingId !== null || !pending.create) {
            setDraft(next)
          }
        }}
        onSave={() => void save()}
        onRemoveOpenChange={(open) => {
          if (!busy) {
            setConfirmDelete(open)
          }
        }}
        onRemove={() => void remove()}
      />
    </main>
  )
}
