import React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import { commandDefinitionFromDraft, type AutomationCommandDraft } from './automation-command-draft'

type Props = {
  open: boolean
  editing: boolean
  busy: boolean
  pendingCreate: boolean
  draft: AutomationCommandDraft
  setups: readonly ProjectHostSetup[]
  error: string | null
  onOpenChange(open: boolean): void
  onDraftChange(draft: AutomationCommandDraft): void
  onSave(): void
}

export function AutomationCommandEditorDialog({
  open,
  editing,
  busy,
  pendingCreate,
  draft,
  setups,
  error,
  onOpenChange,
  onDraftChange,
  onSave
}: Props): React.JSX.Element {
  const [preview, setPreview] = React.useState<string | null>(null)
  const readySetups = setups.filter(
    (setup) => setup.setupState === 'ready' && setup.hostId === 'local'
  )
  const change = (updates: Partial<AutomationCommandDraft>): void => {
    onDraftChange({ ...draft, ...updates })
    setPreview(null)
  }
  const previewDraft = (): void => {
    const setup = readySetups.find((entry) => entry.id === draft.setupId)
    if (!setup) {
      setPreview('Choose a ready project folder on this host.')
      return
    }
    try {
      commandDefinitionFromDraft(draft, setup, 0)
      setPreview('Draft is valid. No command ran.')
    } catch (cause) {
      setPreview(cause instanceof Error ? cause.message : 'The draft is invalid.')
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        surface="security"
        scrollable
        className="scrollbar-sleek max-h-[90vh] max-w-2xl overflow-y-auto"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>
            {editing ? 'Edit command automation' : 'New command automation'}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Run a script on this host and keep its result in history.
          </p>
          {pendingCreate && (
            <p role="status" className="text-sm">
              The previous save may have succeeded. Retry sends the same draft and request.
            </p>
          )}
        </DialogHeader>
        <fieldset disabled={pendingCreate || busy} className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="command-automation-name">Name</Label>
            <Input
              id="command-automation-name"
              value={draft.name}
              onChange={(event) => change({ name: event.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="command-automation-project">Project folder on this host</Label>
            <Select value={draft.setupId} onValueChange={(setupId) => change({ setupId })}>
              <SelectTrigger id="command-automation-project" className="w-full">
                <SelectValue placeholder="Choose project" />
              </SelectTrigger>
              <SelectContent>
                {readySetups.map((setup) => (
                  <SelectItem key={setup.id} value={setup.id}>
                    {setup.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="command-automation-kind">First step</Label>
            <Select
              value={draft.commandKind}
              onValueChange={(value) => {
                if (value === 'shell' || value === 'python' || value === 'program') {
                  change({ commandKind: value })
                }
              }}
            >
              <SelectTrigger id="command-automation-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="shell">Shell script</SelectItem>
                <SelectItem value="python">Python script</SelectItem>
                <SelectItem value="program">Program</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="command-automation-script">
              {draft.commandKind === 'program' ? 'Executable path or name' : 'Script'}
            </Label>
            {draft.commandKind === 'program' ? (
              <Input
                id="command-automation-script"
                className="font-mono"
                value={draft.commandText}
                onChange={(event) => change({ commandText: event.target.value })}
              />
            ) : (
              <Textarea
                id="command-automation-script"
                className="min-h-28 font-mono"
                value={draft.commandText}
                onChange={(event) => change({ commandText: event.target.value })}
              />
            )}
            <p className="text-xs text-muted-foreground">
              The command runs on the selected execution host.
            </p>
          </div>
          {draft.commandKind === 'program' && (
            <div className="grid gap-2">
              <Label htmlFor="command-automation-args">Arguments, one per line</Label>
              <Textarea
                id="command-automation-args"
                className="min-h-20 font-mono"
                value={draft.programArgs}
                onChange={(event) => change({ programArgs: event.target.value })}
              />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="command-automation-condition">Continue when</Label>
            <Select
              value={draft.condition}
              onValueChange={(value) => {
                if (
                  value === 'exit_zero' ||
                  value === 'exit_zero_and_changed' ||
                  value === 'never_agent'
                ) {
                  change({ condition: value })
                }
              }}
            >
              <SelectTrigger id="command-automation-condition" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="never_agent">Never call an agent</SelectItem>
                <SelectItem value="exit_zero">Exit code 0</SelectItem>
                <SelectItem value="exit_zero_and_changed">Exit code 0 and changed JSON</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="command-automation-time">Daily time</Label>
              <Input
                id="command-automation-time"
                type="time"
                value={draft.time}
                onChange={(event) => change({ time: event.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="command-automation-timezone">IANA timezone</Label>
              <Input
                id="command-automation-timezone"
                value={draft.timezone}
                onChange={(event) => change({ timezone: event.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="command-automation-timeout">Timeout, seconds</Label>
              <Input
                id="command-automation-timeout"
                type="number"
                min={1}
                max={3600}
                value={draft.timeoutSeconds}
                onChange={(event) => change({ timeoutSeconds: event.target.value })}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">An overlapping run is skipped.</p>
          {(error || preview) && (
            <p role="status" className="text-sm">
              {error ?? preview}
            </p>
          )}
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={previewDraft} disabled={busy || pendingCreate}>
            Validate draft
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy}>
            {editing ? 'Save changes' : pendingCreate ? 'Retry same save' : 'Save draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
