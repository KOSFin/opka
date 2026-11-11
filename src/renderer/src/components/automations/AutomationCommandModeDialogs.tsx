import React from 'react'
import type { AutomationCommandReportTargetOption } from '../../../../shared/automation-command-domain'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { AutomationCommandDraft } from './automation-command-draft'
import { AutomationCommandEditorDialog } from './AutomationCommandEditorDialog'
import { AutomationCommandRemoveDialog } from './AutomationCommandRemoveDialog'

type Props = {
  editorOpen: boolean
  editing: boolean
  pendingCreate: boolean
  busy: boolean
  draft: AutomationCommandDraft
  setups: readonly ProjectHostSetup[]
  reportTargets: readonly AutomationCommandReportTargetOption[]
  error: string | null
  removeName: string | null
  onEditorOpenChange(open: boolean): void
  onDraftChange(draft: AutomationCommandDraft): void
  onSave(): void
  onRemoveOpenChange(open: boolean): void
  onRemove(): void
}

export function AutomationCommandModeDialogs(props: Props): React.JSX.Element {
  return (
    <>
      <AutomationCommandEditorDialog
        open={props.editorOpen}
        editing={props.editing}
        pendingCreate={props.pendingCreate}
        busy={props.busy}
        draft={props.draft}
        setups={props.setups}
        reportTargets={props.reportTargets}
        error={props.error}
        onOpenChange={props.onEditorOpenChange}
        onDraftChange={props.onDraftChange}
        onSave={props.onSave}
      />
      <AutomationCommandRemoveDialog
        name={props.removeName}
        busy={props.busy}
        onOpenChange={props.onRemoveOpenChange}
        onConfirm={props.onRemove}
      />
    </>
  )
}
