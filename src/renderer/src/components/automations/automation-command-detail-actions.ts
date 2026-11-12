import type { AutomationCommandDefinitionV1 } from '../../../../shared/automation-command-domain'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { AutomationHostTarget } from './automation-host-client'
import type { PendingRequests } from './automation-command-pending-requests'
import type { useAutomationCommandViewFence } from './use-automation-command-view-fence'
import {
  deleteCommandAutomationForTarget,
  updateCommandAutomationForTarget
} from './automation-command-host-client'
import { commandHostErrorMessage } from './automation-command-report-selection'
import { requestCommandRunCancel } from './automation-command-cancel-operation'
import { admitCommandManualRun } from './automation-command-run-operation'

type Input = {
  stableTarget: AutomationHostTarget
  selected: AutomationCommandDefinitionV1 | null
  selectedRun: AutomationRun | null
  pending: PendingRequests
  view: ReturnType<typeof useAutomationCommandViewFence>
  setBusy(value: boolean): void
  setError(value: string | null): void
  setNotice(value: string | null): void
  setConfirmDelete(value: boolean): void
  refresh(): Promise<void>
  refreshRuns(): Promise<void>
  onChanged(): void
  onRemoved(): void
}

export function createAutomationCommandDetailActions({
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
}: Input) {
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
  const toggle = async (): Promise<void> => {
    if (!selected) {
      return
    }
    const actionEpoch = view.capture()
    setBusy(true)
    try {
      await updateCommandAutomationForTarget(stableTarget, selected.id, selected.revision, {
        enabled: !selected.enabled
      })
      if (!view.current(actionEpoch)) {
        return
      }
      setError(null)
      await refresh()
      onChanged()
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
      setNotice('Automation removed from this host.')
      setError(null)
      await refresh()
      onChanged()
      if (view.current(actionEpoch)) {
        onRemoved()
      }
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

  return { runNow, cancel, toggle, remove }
}
