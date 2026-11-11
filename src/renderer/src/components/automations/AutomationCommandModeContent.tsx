import React from 'react'
import type { AutomationCommandDefinitionV1 } from '../../../../shared/automation-command-domain'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { AutomationHostTarget } from './automation-host-client'
import type { PendingCommandRun } from './automation-command-pending-requests'
import { AutomationCommandDefinitionList } from './AutomationCommandDefinitionList'
import { AutomationCommandDetails } from './AutomationCommandDetails'

type Props = {
  definitions: readonly AutomationCommandDefinitionV1[]
  selectedId: string | null
  selected: AutomationCommandDefinitionV1 | null
  runs: readonly AutomationRun[]
  selectedRun: AutomationRun | null
  busy: boolean
  retrySameRequest: boolean
  target: AutomationHostTarget
  pendingRun: PendingCommandRun | null
  onSelectDefinition(id: string): void
  onRunReconciled(runId: string, overlap: boolean): void
  onStartNewRun(): void
  onEdit(): void
  onRun(): void
  onRemove(): void
  onSelectRun(id: string): void
  onRefreshRuns(): void
  onCancel(): void
}

export function AutomationCommandModeContent(props: Props): React.JSX.Element {
  return (
    <div className="grid min-h-0 flex-1 gap-4 pt-4 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]">
      <AutomationCommandDefinitionList
        definitions={props.definitions}
        selectedId={props.selectedId}
        busy={props.busy}
        onSelect={props.onSelectDefinition}
      />
      <AutomationCommandDetails
        selected={props.selected}
        runs={props.runs}
        selectedRun={props.selectedRun}
        busy={props.busy}
        retrySameRequest={props.retrySameRequest}
        target={props.target}
        pendingRun={props.pendingRun}
        onRunReconciled={props.onRunReconciled}
        onStartNewRun={props.onStartNewRun}
        onEdit={props.onEdit}
        onRun={props.onRun}
        onRemove={props.onRemove}
        onSelectRun={props.onSelectRun}
        onRefreshRuns={props.onRefreshRuns}
        onCancel={props.onCancel}
      />
    </div>
  )
}
