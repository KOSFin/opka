import React from 'react'
import { Button } from '@/components/ui/button'
import type { AutomationRun } from '../../../../shared/automations-types'

type Props = {
  runs: readonly AutomationRun[]
  selectedRun: AutomationRun | null
  busy: boolean
  onSelectRun(id: string): void
  onRefresh(): void
  onCancel(): void
}

export function AutomationCommandHistory({
  runs,
  selectedRun,
  busy,
  onSelectRun,
  onRefresh,
  onCancel
}: Props): React.JSX.Element {
  return (
    <>
      <div className="mt-5 flex items-center justify-between">
        <h3 className="text-sm font-semibold">History</h3>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={busy}>
          Refresh history
        </Button>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(9rem,14rem)_minmax(0,1fr)]">
        <div className="grid content-start gap-1">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              data-current={run.id === selectedRun?.id}
              className="rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[current=true]:bg-accent"
              onClick={() => onSelectRun(run.id)}
            >
              {run.status} · {new Date(run.createdAt).toLocaleString()}
            </button>
          ))}
          {runs.length === 0 && <p className="text-sm text-muted-foreground">No runs yet.</p>}
        </div>
        <div className="rounded-md border border-border p-3">
          {selectedRun ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{selectedRun.title}</p>
                {selectedRun.status === 'dispatching' && (
                  <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
                    Cancel run
                  </Button>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedRun.commandExecution?.phase ?? 'unknown'} ·{' '}
                {selectedRun.commandExecution?.deliveryStatus ?? 'history pending'}
              </p>
              <pre className="scrollbar-sleek mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
                {selectedRun.outputSnapshot?.content ?? 'Report not yet available.'}
              </pre>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Select a run to read its durable report.
            </p>
          )}
        </div>
      </div>
    </>
  )
}
