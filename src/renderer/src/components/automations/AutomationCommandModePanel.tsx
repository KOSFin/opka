import React from 'react'
import type { AutomationCommandDefinitionV1 } from '../../../../shared/automation-command-domain'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import {
  deleteCommandAutomationForTarget,
  listCommandAutomationRunsForTarget,
  listCommandAutomationsForTarget
} from './automation-command-host-client'
import {
  getAutomationHostTargetFromKey,
  getAutomationHostTargetKey,
  type AutomationHostTarget
} from './automation-host-client'
import { AutomationCommandEditorDialog } from './AutomationCommandEditorDialog'
import { AutomationCommandDetails } from './AutomationCommandDetails'
import { AutomationCommandDefinitionList } from './AutomationCommandDefinitionList'
import { AutomationCommandModeToolbar } from './AutomationCommandModeToolbar'
import { AutomationCommandArchive } from './AutomationCommandArchive'
import { AutomationCommandRemoveDialog } from './AutomationCommandRemoveDialog'
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
  onBack(): void
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The execution host did not answer.'
}

export function AutomationCommandModePanel({ target, setups, onBack }: Props): React.JSX.Element {
  const [definitions, setDefinitions] = React.useState<AutomationCommandDefinitionV1[]>([])
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
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null
  const selectedPendingRun = selected ? (pending.runs.get(selected.id) ?? null) : null

  const refresh = React.useCallback(async (): Promise<void> => {
    const request = ++definitionRequest.current
    try {
      const next = await listCommandAutomationsForTarget(stableTarget)
      if (request !== definitionRequest.current) {
        return
      }
      setDefinitions(next)
      if (
        pending.create &&
        next.some((entry) => entry.creationKey === pending.create?.input.creationKey)
      ) {
        pending.create = null
      }
      setSelectedId((id) => (next.some((entry) => entry.id === id) ? id : (next[0]?.id ?? null)))
      setError(null)
    } catch (cause) {
      if (request !== definitionRequest.current) {
        return
      }
      setDefinitions([])
      setSelectedId(null)
      setError(errorMessage(cause))
    }
  }, [stableTarget, pending])

  React.useEffect(() => {
    setDefinitions([])
    setRuns([])
    setSelectedId(null)
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
      setSelectedRunId((id) => (next.some((run) => run.id === id) ? id : (next[0]?.id ?? null)))
      setError(null)
    } catch (cause) {
      if (request !== runRequest.current) {
        return
      }
      setRuns([])
      setError(errorMessage(cause))
    }
  }, [selectedId, stableTarget])

  React.useEffect(() => {
    setRuns([])
    setSelectedRunId(null)
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
        setError(errorMessage(cause))
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
        setError(errorMessage(cause))
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
        setError(errorMessage(cause))
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
        setError(errorMessage(cause))
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
        <div className="grid min-h-0 flex-1 gap-4 pt-4 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]">
          <AutomationCommandDefinitionList
            definitions={definitions}
            selectedId={selectedId}
            busy={busy}
            onSelect={(id) => {
              view.advance()
              setSelectedId(id)
              setConfirmDelete(false)
            }}
          />
          <AutomationCommandDetails
            selected={selected}
            runs={runs}
            selectedRun={selectedRun}
            busy={busy}
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
            onSelectRun={setSelectedRunId}
            onRefreshRuns={() => void refreshRuns()}
            onCancel={() => void cancel()}
          />
        </div>
      )}
      <AutomationCommandEditorDialog
        open={editorOpen}
        editing={editingId !== null}
        busy={busy}
        draft={draft}
        setups={setups}
        error={error}
        pendingCreate={editingId === null && pending.create !== null}
        onOpenChange={(open) => {
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
      />
      <AutomationCommandRemoveDialog
        name={confirmDelete ? (selected?.name ?? null) : null}
        busy={busy}
        onOpenChange={(open) => {
          if (!busy) {
            setConfirmDelete(open)
          }
        }}
        onConfirm={() => void remove()}
      />
    </main>
  )
}
