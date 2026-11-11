import React from 'react'
import { Button } from '@/components/ui/button'
import type { AutomationCommandDefinitionV1 } from '../../../../shared/automation-command-domain'
import type { AutomationRun } from '../../../../shared/automations-types'
import { AutomationCommandHistory } from './AutomationCommandHistory'
import { AutomationCommandRunRecovery } from './AutomationCommandRunRecovery'
import type { AutomationHostTarget } from './automation-host-client'
import type { PendingCommandRun } from './automation-command-pending-requests'

type Props = {
  selected: AutomationCommandDefinitionV1 | null
  runs: readonly AutomationRun[]
  selectedRun: AutomationRun | null
  busy: boolean
  retrySameRequest: boolean
  target: AutomationHostTarget
  pendingRun: PendingCommandRun | null
  onRunReconciled(runId: string, overlap: boolean): void
  onStartNewRun(): void
  onEdit(): void
  onRun(): void
  onRemove(): void
  onSelectRun(id: string): void
  onRefreshRuns(): void
  onCancel(): void
}

export function AutomationCommandDetails({
  selected,
  runs,
  selectedRun,
  busy,
  retrySameRequest,
  target,
  pendingRun,
  onRunReconciled,
  onStartNewRun,
  onEdit,
  onRun,
  onRemove,
  onSelectRun,
  onRefreshRuns,
  onCancel
}: Props): React.JSX.Element {
  return (
    <section
      aria-label="Command automation details"
      className="scrollbar-sleek min-h-0 overflow-y-auto rounded-md border border-border p-4"
    >
      {selected && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">{selected.name}</h2>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={onEdit} disabled={busy}>
                Edit
              </Button>
              <Button onClick={onRun} disabled={busy}>
                {retrySameRequest ? 'Retry same request' : 'Run now'}
              </Button>
              <Button variant="outline" onClick={onRemove} disabled={busy}>
                Remove
              </Button>
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            {selected.runContext?.path} · {selected.rrule}
          </p>
          <AutomationCommandHistory
            runs={runs}
            selectedRun={selectedRun}
            busy={busy}
            onSelectRun={onSelectRun}
            onRefresh={onRefreshRuns}
            onCancel={onCancel}
          />
          {pendingRun && (
            <AutomationCommandRunRecovery
              key={pendingRun.key}
              target={target}
              request={pendingRun}
              busy={busy}
              onAdmitted={onRunReconciled}
              onStartNew={onStartNewRun}
            />
          )}
        </>
      )}
    </section>
  )
}
