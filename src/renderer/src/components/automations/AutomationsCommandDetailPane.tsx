import { Button } from '@/components/ui/button'
import { AutomationCommandDetails } from './AutomationCommandDetails'
import { AutomationCommandRemoveDialog } from './AutomationCommandRemoveDialog'
import type { AutomationCommandState } from './use-automation-command-state'

export function AutomationsCommandDetailPane({
  command,
  onBack,
  onEdit
}: {
  command: AutomationCommandState
  onBack(): void
  onEdit(): void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pb-4">
      <div>
        <Button variant="outline" onClick={onBack}>
          Back to automations
        </Button>
      </div>
      {command.notice && (
        <p role="status" className="text-sm">
          {command.notice}
        </p>
      )}
      <AutomationCommandDetails
        selected={command.selected}
        runs={command.runs}
        selectedRun={command.selectedRun}
        busy={command.busy}
        retrySameRequest={command.selected ? command.pending.runs.has(command.selected.id) : false}
        target={command.stableTarget}
        pendingRun={command.selectedPendingRun}
        onRunReconciled={(runId) => {
          if (command.selected) {
            command.pending.runs.delete(command.selected.id)
          }
          command.setSelectedRunId(runId)
          void command.refreshRuns()
        }}
        onStartNewRun={() => {
          if (command.selected) {
            command.pending.runs.delete(command.selected.id)
          }
          void command.runNow()
        }}
        onToggle={() => void command.toggle()}
        onEdit={onEdit}
        onRun={() => void command.runNow()}
        onRemove={() => command.setConfirmDelete(true)}
        onSelectRun={command.setSelectedRunId}
        onRefreshRuns={() => void command.refreshRuns()}
        onCancel={() => void command.cancel()}
      />
      <AutomationCommandRemoveDialog
        name={command.confirmDelete ? (command.selected?.name ?? null) : null}
        busy={command.busy}
        onOpenChange={command.setConfirmDelete}
        onConfirm={() => void command.remove()}
      />
    </div>
  )
}
